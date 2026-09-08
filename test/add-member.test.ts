import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, adminCreateTeam, listEventTeams, listSignups, setSignup, adminUpdateSignup, addMemberParticipant, RuleError } from '../src/lib/db';

// Putting a member on a roster by hand. The point of this over the walk-in
// path is that the signup belongs to their own Discord account, so the
// event role, their ticks and their stats all find them.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['signups', 'event_teams', 'events', 'announcements', 'members', 'register']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function entry(name: string, discordId: string | null, status = 'member'): Promise<number> {
  const row = await db()
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, discord_name, status, source, applied_at, consented_at, updated_at, search_key)
       VALUES (?1, 'Lahti', ?2, 'LUT', 'LTKY', 'full', ?3, ?4, ?5, 'board', 1, 1, 1, ?6)
       RETURNING id`,
    )
    .bind(name, `${name}@example.com`, discordId, discordId ? `${name}_dc` : null, status, name.toLowerCase())
    .first<{ id: number }>();
  return row!.id;
}

async function teamEvent(teamSize: number | null): Promise<number> {
  await upsertMember(db(), { discord_id: 'admin', username: 'admin', avatar_hash: null }, NOW);
  return createEvent(
    db(),
    { title: 'CS2 cup', description: null, starts_at: NOW + 86400, capacity: null, team_size: teamSize, organizers: 'LahtiAG', created_by: 'admin' },
    NOW,
  );
}

beforeEach(wipe);

describe('adding a member to an event by hand', () => {
  it('signs them up against their own Discord account, not a placeholder', async () => {
    const eventId = await teamEvent(null);
    const id = await entry('Liam', '900000000000000001');
    const discordId = await addMemberParticipant(db(), eventId, id, 'yes', null, NOW);
    expect(discordId).toBe('900000000000000001');
    const signups = await listSignups(db(), eventId);
    expect(signups.map((s) => [s.discord_id, s.status])).toEqual([['900000000000000001', 'yes']]);
  });

  it('refuses a member with no Discord account linked', async () => {
    const eventId = await teamEvent(null);
    const id = await entry('Nolink', null);
    await expect(addMemberParticipant(db(), eventId, id, 'yes', null, NOW)).rejects.toMatchObject({ code: 'not_linked' });
  });

  it('refuses an entry that is not a current member', async () => {
    const eventId = await teamEvent(null);
    const id = await entry('Pending', '900000000000000009', 'pending');
    await expect(addMemberParticipant(db(), eventId, id, 'yes', null, NOW)).rejects.toBeInstanceOf(RuleError);
  });

  it('moves someone already on the roster into a team instead of refusing', async () => {
    const eventId = await teamEvent(2);
    const id = await entry('Valtteri', '900000000000000002');
    await upsertMember(db(), { discord_id: '900000000000000002', username: 'axinikk', avatar_hash: null }, NOW);
    await setSignup(db(), eventId, '900000000000000002', 'maybe', NOW);
    const teamId = await adminCreateTeam(db(), eventId, 'Kapital', 'admin', NOW);

    await addMemberParticipant(db(), eventId, id, 'maybe', teamId, NOW);
    const signups = await listSignups(db(), eventId);
    const mine = signups.filter((s) => s.discord_id === '900000000000000002');
    expect(mine.length).toBe(1); // moved, not duplicated
    // A team means Going, whatever was asked for.
    expect(mine[0].status).toBe('yes');
    expect(mine[0].event_team_id).toBe(teamId);
  });

  it('counts a full team, but not against someone already in it', async () => {
    const eventId = await teamEvent(2);
    const teamId = await adminCreateTeam(db(), eventId, 'Kapital', 'admin', NOW);
    const a = await entry('Ann', '900000000000000003');
    const b = await entry('Bo', '900000000000000004');
    const c = await entry('Cee', '900000000000000005');
    await addMemberParticipant(db(), eventId, a, 'yes', teamId, NOW);
    await addMemberParticipant(db(), eventId, b, 'yes', teamId, NOW);
    // Re-adding someone who is already in the team is not one more body.
    await addMemberParticipant(db(), eventId, a, 'yes', teamId, NOW);
    await expect(addMemberParticipant(db(), eventId, c, 'yes', teamId, NOW)).rejects.toMatchObject({ code: 'team_full' });
    const signups = await listSignups(db(), eventId);
    expect(signups.filter((s) => s.event_team_id === teamId).length).toBe(2);
  });

  it('leaves the other teams alone, however empty they are', async () => {
    // The board makes empty teams on purpose to assign people into, and a
    // bracket imported from an old tournament has teams with no roster at
    // all. Both used to be swept away the moment anyone was moved.
    const eventId = await teamEvent(5);
    const kapital = await adminCreateTeam(db(), eventId, 'Kapital', 'admin', NOW);
    const other = await adminCreateTeam(db(), eventId, 'Nullpointers', 'admin', NOW);
    const empty = await adminCreateTeam(db(), eventId, 'Byte Me', 'admin', NOW);
    const id = await entry('Valtteri', '900000000000000007');

    await addMemberParticipant(db(), eventId, id, 'yes', kapital, NOW);
    expect((await listEventTeams(db(), eventId)).map((t) => t.id).sort()).toEqual([kapital, other, empty].sort());

    // Moving them on disbands only the team they left.
    await adminUpdateSignup(db(), eventId, '900000000000000007', 'yes', other);
    const left = (await listEventTeams(db(), eventId)).map((t) => t.id);
    expect(left).toContain(other);
    expect(left).toContain(empty);
    expect(left).not.toContain(kapital);
  });

  it('refuses a team on an event that takes no teams', async () => {
    const eventId = await teamEvent(null);
    const id = await entry('Solo', '900000000000000006');
    await expect(addMemberParticipant(db(), eventId, id, 'yes', 1, NOW)).rejects.toMatchObject({ code: 'not_team_event' });
  });
});
