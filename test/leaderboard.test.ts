import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setSignup, generateBracket, getBracket, setBracketWinner, setLeaderboardOptIn, isLeaderboardOptIn, leaderboard } from '../src/lib/db';

// Opt-in only, counted from past events and finals.

const NOW = 1_760_000_000;
const db = () => env.DB;

describe('leaderboard', () => {
  beforeEach(async () => {
    for (const table of ['bracket_matches', 'signups', 'event_teams', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
    for (const p of ['host', '1', '2']) await upsertMember(db(), { discord_id: p, username: `p${p}`, avatar_hash: null }, NOW);
  });

  it('lists only members who opted in, by events and by wins', async () => {
    const cup = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 10, capacity: null, created_by: 'host' }, NOW);
    await setSignup(db(), cup, '1', 'yes', NOW);
    await setSignup(db(), cup, '2', 'yes', NOW);
    await generateBracket(db(), cup, NOW);
    const final = (await getBracket(db(), cup))[0];
    await setBracketWinner(db(), cup, 1, 0, 'u:2');
    void final;
    const social = await createEvent(db(), { title: 'Social', description: null, starts_at: NOW + 20, capacity: null, created_by: 'host' }, NOW);
    await setSignup(db(), social, '1', 'yes', NOW);
    const later = NOW + 86400;
    expect(await leaderboard(db(), later)).toEqual({ events: [], wins: [] });
    await setLeaderboardOptIn(db(), '1', true);
    await setLeaderboardOptIn(db(), '2', true);
    expect(await isLeaderboardOptIn(db(), '1')).toBe(true);
    const board = await leaderboard(db(), later);
    expect(board.events.map((r) => [r.username, r.attended])).toEqual([['p1', 2], ['p2', 1]]);
    expect(board.wins.map((r) => [r.username, r.wins])).toEqual([['p2', 1]]);
    await setLeaderboardOptIn(db(), '2', false);
    expect((await leaderboard(db(), later)).wins).toEqual([]);
  });
});
