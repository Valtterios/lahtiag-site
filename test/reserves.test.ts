import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  updateEvent,
  getEvent,
  createEventTeam,
  joinEventTeam,
  leaveEventTeam,
  listSignups,
  setSignup,
  setTeamPlace,
  captainSetTeamPlace,
  captainAddToTeam,
  adminUpdateSignup,
  addMemberParticipant,
  addManualParticipant,
} from '../src/lib/db';

// Six players for a five-a-side: the team's line-up fills first, the
// bench takes the rest, and either the captain or the board swaps them.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function people(ids: string[]): Promise<void> {
  for (const id of ids) await upsertMember(db(), { discord_id: id, username: `player ${id}`, avatar_hash: null }, NOW);
}

async function teamEvent(teamSize: number, reserves: number): Promise<number> {
  return createEvent(
    db(),
    { title: 'CS2 cup', description: null, starts_at: NOW + 86400, capacity: null, team_size: teamSize, team_reserves: reserves, created_by: 'host' },
    NOW,
  );
}

const placeOf = async (eventId: number, discordId: string) =>
  (await listSignups(db(), eventId)).find((s) => s.discord_id === discordId)?.reserve;

describe('reserves', () => {
  beforeEach(async () => {
    for (const table of ['bracket_matches', 'brackets', 'signups', 'event_teams', 'events', 'members', 'register']) {
      await db().prepare(`DELETE FROM ${table}`).run();
    }
    await people(['host', '1', '2', '3', '4']);
  });

  it('fills the line-up, then the bench, then turns people away', async () => {
    const cup = await teamEvent(2, 1);
    const team = await createEventTeam(db(), cup, 'Kapital', '1', NOW);
    await joinEventTeam(db(), cup, team, '2', NOW);
    await joinEventTeam(db(), cup, team, '3', NOW); // the line-up is full: onto the bench
    expect(await placeOf(cup, '1')).toBe(0);
    expect(await placeOf(cup, '2')).toBe(0);
    expect(await placeOf(cup, '3')).toBe(1);
    await expect(joinEventTeam(db(), cup, team, '4', NOW)).rejects.toMatchObject({ code: 'team_full' });
    // Leaving takes the bench place with it.
    await leaveEventTeam(db(), cup, '3');
    expect(await placeOf(cup, '3')).toBe(0);
    await joinEventTeam(db(), cup, team, '4', NOW);
    expect(await placeOf(cup, '4')).toBe(1);
  });

  it('is nought by default: a team is its line-up and nothing more', async () => {
    const cup = await teamEvent(2, 0);
    const team = await createEventTeam(db(), cup, 'Linkki', '1', NOW);
    await joinEventTeam(db(), cup, team, '2', NOW);
    await expect(joinEventTeam(db(), cup, team, '3', NOW)).rejects.toMatchObject({ code: 'team_full' });
    expect((await getEvent(db(), cup))?.team_reserves).toBe(0);
  });

  it('swaps a player between the bench and the line-up, for the captain and for the board', async () => {
    const cup = await teamEvent(2, 1);
    const team = await createEventTeam(db(), cup, 'Kapital', '1', NOW);
    await joinEventTeam(db(), cup, team, '2', NOW);
    await joinEventTeam(db(), cup, team, '3', NOW);
    // A switch is two moves: one off, one on. Bringing the reserve on
    // while the line-up is full is refused, and says so.
    await expect(captainSetTeamPlace(db(), cup, team, '1', '3', false, NOW)).rejects.toMatchObject({ code: 'team_full' });
    await captainSetTeamPlace(db(), cup, team, '1', '2', true, NOW); // the bench always takes one more
    expect(await placeOf(cup, '2')).toBe(1);
    await captainSetTeamPlace(db(), cup, team, '1', '3', false, NOW);
    expect(await placeOf(cup, '3')).toBe(0);
    // Only the team's founder, and only somebody in the team.
    await expect(captainSetTeamPlace(db(), cup, team, '2', '3', true, NOW)).rejects.toMatchObject({ code: 'not_captain' });
    await expect(captainSetTeamPlace(db(), cup, team, '1', '4', true, NOW)).rejects.toMatchObject({ code: 'missing' });
    // The board does the same from the roster, closed signups or not.
    await setTeamPlace(db(), cup, '3', true);
    expect(await placeOf(cup, '3')).toBe(1);
    await expect(setTeamPlace(db(), cup, '4', true)).rejects.toMatchObject({ code: 'missing' });
  });

  it('lets the board say which place, and refuses the one that is taken', async () => {
    const cup = await teamEvent(2, 1);
    const team = await createEventTeam(db(), cup, 'Kapital', '1', NOW);
    await joinEventTeam(db(), cup, team, '2', NOW);
    await setSignup(db(), cup, '3', 'yes', NOW);
    await setSignup(db(), cup, '4', 'yes', NOW);
    // The line-up is full, so the roster edit puts them on the bench...
    await adminUpdateSignup(db(), cup, '3', 'yes', team);
    expect(await placeOf(cup, '3')).toBe(1);
    // ...and asking for the line-up outright is refused.
    await expect(adminUpdateSignup(db(), cup, '4', 'yes', team, false)).rejects.toMatchObject({ code: 'team_full' });
    await expect(adminUpdateSignup(db(), cup, '4', 'yes', team, true)).rejects.toMatchObject({ code: 'team_full' });
    // Moving somebody out of a team clears the bench place.
    await adminUpdateSignup(db(), cup, '3', 'maybe', null);
    expect(await placeOf(cup, '3')).toBe(0);
    // A walk-in and a captain's pick land the same way.
    await captainAddToTeam(db(), cup, team, '1', '3', NOW);
    expect(await placeOf(cup, '3')).toBe(1);
    await expect(addManualParticipant(db(), cup, 'Stranger', 'yes', team, NOW)).rejects.toMatchObject({ code: 'team_full' });
    expect((await listSignups(db(), cup)).filter((s) => s.event_team_id === team)).toHaveLength(3);
  });

  it('grows freely, shrinks only when the bench is clear, and empties when it goes', async () => {
    const cup = await teamEvent(2, 1);
    const team = await createEventTeam(db(), cup, 'Kapital', '1', NOW);
    await joinEventTeam(db(), cup, team, '2', NOW);
    await joinEventTeam(db(), cup, team, '3', NOW);
    const base = { title: 'CS2 cup', description: null, starts_at: NOW + 86400, ends_at: null, capacity: null, organizers: null, link_url: null };
    expect((await updateEvent(db(), cup, { ...base, team_reserves: 3 })).team_reserves).toBe(3);
    expect((await updateEvent(db(), cup, { ...base })).team_reserves).toBe(3); // untouched when not given
    await expect(updateEvent(db(), cup, { ...base, team_reserves: -1 })).rejects.toMatchObject({ code: 'bad_input' });
    // Three on the team: down to no reserves at all is one too few places.
    await expect(updateEvent(db(), cup, { ...base, team_reserves: 0 })).rejects.toMatchObject({ code: 'team_reserves' });
    expect((await updateEvent(db(), cup, { ...base, team_reserves: 1 })).team_reserves).toBe(1);
    // A smaller line-up sends the last to join to the bench.
    const shrunk = await updateEvent(db(), cup, { ...base, team_size: 1, team_reserves: 2 });
    expect(shrunk.team_size).toBe(1);
    expect(await placeOf(cup, '1')).toBe(0); // the founder joined first
    expect(await placeOf(cup, '2')).toBe(1);
    expect(await placeOf(cup, '3')).toBe(1);
    // Losing the bench altogether puts everybody back in the line-up.
    expect((await updateEvent(db(), cup, { ...base, team_size: 3, team_reserves: 0 })).team_reserves).toBe(0);
    for (const who of ['1', '2', '3']) expect(await placeOf(cup, who)).toBe(0);
  });
});

describe('reserves and the register', () => {
  beforeEach(async () => {
    for (const table of ['bracket_matches', 'brackets', 'signups', 'event_teams', 'events', 'members', 'register']) {
      await db().prepare(`DELETE FROM ${table}`).run();
    }
    await people(['host', '1', '2']);
  });

  it('puts a member the board adds wherever the team has room', async () => {
    const cup = await teamEvent(1, 1);
    const team = await createEventTeam(db(), cup, 'Kapital', '1', NOW);
    const row = await db()
      .prepare(
        `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, discord_name, status, source, applied_at, consented_at, updated_at, search_key)
         VALUES ('Toivo', 'Lahti', 't@x.fi', 'LUT', 'LTKY', 'full', '2', 'toivo', 'member', 'board', ?1, ?1, ?1, 'toivo')
         RETURNING id`,
      )
      .bind(NOW)
      .first<{ id: number }>();
    await addMemberParticipant(db(), cup, row!.id, 'yes', team, NOW);
    expect(await placeOf(cup, '2')).toBe(1);
  });
});
