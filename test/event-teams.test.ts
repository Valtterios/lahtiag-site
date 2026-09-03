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
  adminRemoveSignup,
  adminUpdateSignup,
  addManualParticipant,
  purgeMember,
  setSignupsClosed,
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

describe('admin participant management', () => {
  it('adminRemoveSignup works even when signups are closed and disbands empties', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await createEventTeam(db(), eventId, 'Duo', 'a', NOW);
    await setSignupsClosed(db(), eventId, true, NOW);
    await adminRemoveSignup(db(), eventId, 'a');
    expect(await listSignups(db(), eventId)).toHaveLength(0);
    expect(await listEventTeams(db(), eventId)).toHaveLength(0);
  });

  it('purgeMember erases signups everywhere and deletes a referenced-nowhere member', async () => {
    const e1 = await teamEvent(2, null);
    await member('victim');
    await member('friend');
    const teamId = await createEventTeam(db(), e1, 'Duo', 'friend', NOW);
    await joinEventTeam(db(), e1, teamId, 'victim', NOW);
    const e2 = await createEvent(
      db(),
      { title: 'Solo', description: null, starts_at: NOW + 1, capacity: null, created_by: 'admin' },
      NOW,
    );
    await setSignup(db(), e2, 'victim', 'yes', NOW);
    expect(await purgeMember(db(), 'victim')).toBe('deleted');
    expect((await listSignups(db(), e1)).map((s) => s.discord_id)).toEqual(['friend']);
    expect(await listSignups(db(), e2)).toHaveLength(0);
    const row = await db()
      .prepare("SELECT COUNT(*) AS n FROM members WHERE discord_id = 'victim'")
      .first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it('purgeMember anonymizes a member whom foreign keys still reference', async () => {
    await member('creator');
    await createEvent(
      db(),
      { title: 'Theirs', description: null, starts_at: NOW + 1, capacity: null, created_by: 'creator' },
      NOW,
    );
    expect(await purgeMember(db(), 'creator')).toBe('anonymized');
    const row = await db()
      .prepare("SELECT username FROM members WHERE discord_id = 'creator'")
      .first<{ username: string }>();
    expect(row!.username).toBe('Deleted member');
  });
});

describe('adminUpdateSignup', () => {
  it('changes status and moves between teams even when signups are closed', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await member('b');
    const t1 = await createEventTeam(db(), eventId, 'One', 'a', NOW);
    await setSignup(db(), eventId, 'b', 'yes', NOW); // free agent
    await setSignupsClosed(db(), eventId, true, NOW);
    await adminUpdateSignup(db(), eventId, 'b', 'yes', t1);
    let signups = await listSignups(db(), eventId);
    expect(signups.find((s) => s.discord_id === 'b')!.event_team_id).toBe(t1);
    // Pulling the founder out to 'maybe' clears their team; team survives via b.
    await adminUpdateSignup(db(), eventId, 'a', 'maybe', null);
    signups = await listSignups(db(), eventId);
    const a = signups.find((s) => s.discord_id === 'a')!;
    expect(a.status).toBe('maybe');
    expect(a.event_team_id).toBeNull();
    expect(await listEventTeams(db(), eventId)).toHaveLength(1);
  });

  it('forces yes when a team is picked, and still respects team size', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await member('b');
    await member('c');
    const t1 = await createEventTeam(db(), eventId, 'Duo', 'a', NOW);
    await joinEventTeam(db(), eventId, t1, 'c', NOW); // full at 2
    await setSignup(db(), eventId, 'b', 'maybe', NOW);
    await expect(adminUpdateSignup(db(), eventId, 'b', 'maybe', t1)).rejects.toMatchObject({
      code: 'team_full',
    });
    await adminRemoveSignup(db(), eventId, 'c'); // frees a slot
    await adminUpdateSignup(db(), eventId, 'b', 'maybe', t1);
    const b = (await listSignups(db(), eventId)).find((s) => s.discord_id === 'b')!;
    expect(b.status).toBe('yes');
    expect(b.event_team_id).toBe(t1);
  });

  it('rejects a missing signup, a foreign team, and teams on a solo event', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    await expect(adminUpdateSignup(db(), eventId, 'a', 'yes', null)).rejects.toMatchObject({
      code: 'missing',
    });
    await setSignup(db(), eventId, 'a', 'yes', NOW);
    await expect(adminUpdateSignup(db(), eventId, 'a', 'yes', 99999)).rejects.toMatchObject({
      code: 'missing',
    });
    const soloId = await createEvent(
      db(),
      { title: 'Solo', description: null, starts_at: NOW + 1, capacity: null, created_by: 'admin' },
      NOW,
    );
    await setSignup(db(), soloId, 'a', 'yes', NOW);
    await expect(adminUpdateSignup(db(), soloId, 'a', 'yes', 1)).rejects.toMatchObject({
      code: 'not_team_event',
    });
  });
});

describe('addManualParticipant', () => {
  it('creates a synthetic member and signup, ignoring closed signups and capacity', async () => {
    await member('admin');
    const eventId = await createEvent(
      db(),
      { title: 'LAN', description: null, starts_at: NOW + 1, capacity: 1, created_by: 'admin' },
      NOW,
    );
    await member('a');
    await setSignup(db(), eventId, 'a', 'yes', NOW); // event now at capacity
    await setSignupsClosed(db(), eventId, true, NOW);
    const id = await addManualParticipant(db(), eventId, ' Walk-in Ville ', 'yes', null, NOW);
    expect(id).toMatch(/^manual-[0-9a-f]{16}$/);
    const signups = await listSignups(db(), eventId);
    expect(signups).toHaveLength(2);
    const manual = signups.find((s) => s.discord_id === id)!;
    expect(manual.username).toBe('Walk-in Ville');
    expect(manual.status).toBe('yes');
  });

  it('can land directly in a team (forced yes) but not overfill it', async () => {
    const eventId = await teamEvent(2, null);
    await member('a');
    const t1 = await createEventTeam(db(), eventId, 'Duo', 'a', NOW);
    const id = await addManualParticipant(db(), eventId, 'Guest', 'maybe', t1, NOW);
    const manual = (await listSignups(db(), eventId)).find((s) => s.discord_id === id)!;
    expect(manual.status).toBe('yes');
    expect(manual.event_team_id).toBe(t1);
    await expect(addManualParticipant(db(), eventId, 'Third', 'yes', t1, NOW)).rejects.toMatchObject(
      { code: 'team_full' },
    );
  });

  it('validates the name and the target team', async () => {
    const eventId = await teamEvent(2, null);
    await expect(addManualParticipant(db(), eventId, '   ', 'yes', null, NOW)).rejects.toMatchObject(
      { code: 'bad_input' },
    );
    await expect(addManualParticipant(db(), eventId, 'X', 'yes', 424242, NOW)).rejects.toMatchObject(
      { code: 'missing' },
    );
  });

  it('a manual participant can be removed and purged like anyone else', async () => {
    await member('admin');
    const eventId = await createEvent(
      db(),
      { title: 'LAN', description: null, starts_at: NOW + 1, capacity: null, created_by: 'admin' },
      NOW,
    );
    const id = await addManualParticipant(db(), eventId, 'Guest', 'yes', null, NOW);
    expect(await purgeMember(db(), id)).toBe('deleted');
    expect(await listSignups(db(), eventId)).toHaveLength(0);
  });
});
