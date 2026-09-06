import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setSignup, createEventTeam, joinEventTeam, setSignupsClosed, captainAddToTeam, captainRemoveFromTeam, listSignups } from '../src/lib/db';

// The founder runs the team while signups are open.

const NOW = 1_760_000_000;
const db = () => env.DB;

describe('team captains', () => {
  beforeEach(async () => {
    for (const table of ['signups', 'event_teams', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
    for (const p of ['host', 'cap', 'a', 'b', 'c']) await upsertMember(db(), { discord_id: p, username: p, avatar_hash: null }, NOW);
  });

  it('adds loose players up to the size, takes members out, and refuses everyone else', async () => {
    const id = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, team_size: 2, created_by: 'host' }, NOW);
    const team = await createEventTeam(db(), id, 'Alpha', 'cap', NOW);
    await setSignup(db(), id, 'a', 'maybe', NOW);
    await setSignup(db(), id, 'b', 'yes', NOW);
    await expect(captainAddToTeam(db(), id, team, 'a', 'b', NOW)).rejects.toMatchObject({ code: 'not_captain' });
    await expect(captainAddToTeam(db(), id, team, 'cap', 'c', NOW)).rejects.toMatchObject({ code: 'missing' }); // not signed up
    await captainAddToTeam(db(), id, team, 'cap', 'a', NOW);
    const a = (await listSignups(db(), id)).find((s) => s.discord_id === 'a')!;
    expect(a).toMatchObject({ event_team_id: team, status: 'yes' });
    await expect(captainAddToTeam(db(), id, team, 'cap', 'b', NOW)).rejects.toMatchObject({ code: 'team_full' });
    await expect(captainRemoveFromTeam(db(), id, team, 'cap', 'cap', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await captainRemoveFromTeam(db(), id, team, 'cap', 'a', NOW);
    expect((await listSignups(db(), id)).find((s) => s.discord_id === 'a')?.event_team_id).toBeNull();
    await expect(captainRemoveFromTeam(db(), id, team, 'cap', 'b', NOW)).rejects.toMatchObject({ code: 'missing' });
    await joinEventTeam(db(), id, team, 'b', NOW);
    await expect(captainAddToTeam(db(), id, team, 'cap', 'b', NOW)).rejects.toMatchObject({ code: 'bad_input' }); // already in a team
    await setSignupsClosed(db(), id, true, NOW);
    await expect(captainRemoveFromTeam(db(), id, team, 'cap', 'b', NOW)).rejects.toMatchObject({ code: 'closed' });
  });
});
