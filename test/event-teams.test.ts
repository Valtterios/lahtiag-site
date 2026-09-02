import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  cancelEvent,
  createEventTeam,
  joinEventTeam,
  leaveEventTeam,
  listEventTeams,
  listSignups,
  setSignup,
  removeSignup,
} from '../src/lib/db';

// Tournament team signups against real D1: forming, joining, switching,
// disbanding, and the two capacities (teams per event, players per team).

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['signups', 'event_teams', 'events', 'announcements', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function member(id: string): Promise<void> {
  await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
}

async function teamEvent(teamSize: number, capacity: number | null): Promise<number> {
  await member('admin');
  return createEvent(
    db(),
    {
      title: 'Doubles cup',
      description: null,
      starts_at: NOW + 86400,
      capacity,
      team_size: teamSize,
      organizers: 'LahtiAG, Kapital',
      created_by: 'admin',
    },
    NOW,
  );
}

beforeEach(wipe);

describe('createEventTeam', () => {
  it('creates the team with the founder as first member', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    const teamId = await createEventTeam(db(), eventId, 'Blue Shell', 'a', NOW);
    const signups = await listSignups(db(), eventId);
    expect(signups).toHaveLength(1);
    expect(signups[0]).toMatchObject({ discord_id: 'a', status: 'yes', event_team_id: teamId });
  });

  it('rejects duplicate names case-insensitively', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await member('b');
    await createEventTeam(db(), eventId, 'Blue Shell', 'a', NOW);
    await expect(createEventTeam(db(), eventId, 'blue shell', 'b', NOW)).rejects.toMatchObject({
      code: 'dup_name',
    });
  });

  it('enforces capacity as max teams', async () => {
    const eventId = await teamEvent(2, 1);
    await member('a');
    await member('b');
    await createEventTeam(db(), eventId, 'One', 'a', NOW);
    await expect(createEventTeam(db(), eventId, 'Two', 'b', NOW)).rejects.toMatchObject({
      code: 'full',
    });
  });

  it('rejects team actions on solo and cancelled events', async () => {
    await member('admin');
    await member('a');
    const solo = await createEvent(
      db(),
      { title: 'Solo night', description: null, starts_at: NOW + 1, capacity: null, created_by: 'admin' },
      NOW,
    );
    await expect(createEventTeam(db(), solo, 'X', 'a', NOW)).rejects.toMatchObject({
      code: 'not_team_event',
    });
    const teamed = await teamEvent(2, null);
    await cancelEvent(db(), teamed, NOW);
    await expect(createEventTeam(db(), teamed, 'X', 'a', NOW)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});

describe('joinEventTeam', () => {
  it('fills a team up to team_size and rejects the overflow', async () => {
    const eventId = await teamEvent(2, null);
    for (const id of ['a', 'b', 'c']) await member(id);
    const teamId = await createEventTeam(db(), eventId, 'Duo', 'a', NOW);
    await joinEventTeam(db(), eventId, teamId, 'b', NOW);
    await expect(joinEventTeam(db(), eventId, teamId, 'c', NOW)).rejects.toMatchObject({
      code: 'team_full',
    });
  });

  it('re-joining your own team is not overflow', async () => {
    const eventId = await teamEvent(1, null);
    await member('a');
    const teamId = await createEventTeam(db(), eventId, 'Solo', 'a', NOW);
    await joinEventTeam(db(), eventId, teamId, 'a', NOW);
  });

  it('switching teams disbands an emptied team', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await member('b');
    const first = await createEventTeam(db(), eventId, 'First', 'a', NOW);
    const second = await createEventTeam(db(), eventId, 'Second', 'b', NOW);
    await joinEventTeam(db(), eventId, second, 'a', NOW);
    const teams = await listEventTeams(db(), eventId);
    expect(teams.map((t) => t.id)).toEqual([second]);
    expect(teams.map((t) => t.id)).not.toContain(first);
  });
});

describe('leaving and free agents', () => {
  it('leaveEventTeam keeps the signup as a free agent and disbands empties', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await createEventTeam(db(), eventId, 'Duo', 'a', NOW);
    await leaveEventTeam(db(), eventId, 'a');
    const signups = await listSignups(db(), eventId);
    expect(signups[0]).toMatchObject({ discord_id: 'a', status: 'yes', event_team_id: null });
    expect(await listEventTeams(db(), eventId)).toHaveLength(0);
  });

  it('plain signups on a team event are free agents and ignore capacity', async () => {
    const eventId = await teamEvent(2, 1);
    await member('a');
    await member('b');
    await member('c');
    await createEventTeam(db(), eventId, 'Only', 'a', NOW); // takes the single team slot
    await setSignup(db(), eventId, 'b', 'yes', NOW); // free agent, capacity is teams
    await setSignup(db(), eventId, 'c', 'yes', NOW);
    expect((await listSignups(db(), eventId)).length).toBe(3);
  });

  it('answering via setSignup drops team membership', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await createEventTeam(db(), eventId, 'Duo', 'a', NOW);
    await setSignup(db(), eventId, 'a', 'maybe', NOW);
    const signups = await listSignups(db(), eventId);
    expect(signups[0]).toMatchObject({ status: 'maybe', event_team_id: null });
    expect(await listEventTeams(db(), eventId)).toHaveLength(0);
  });

  it('removeSignup disbands a team emptied by the removal', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await createEventTeam(db(), eventId, 'Duo', 'a', NOW);
    await removeSignup(db(), eventId, 'a');
    expect(await listSignups(db(), eventId)).toHaveLength(0);
    expect(await listEventTeams(db(), eventId)).toHaveLength(0);
  });
});
