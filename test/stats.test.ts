import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setSignup, generateBracket, getBracket, setBracketWinner, memberStats, createAnnouncement, listDueAnnouncements, publishAnnouncement } from '../src/lib/db';
import { profileCardPng } from '../src/lib/profile-card';

// A member's numbers from what is recorded, the card they make, and
// news that publishes itself.

const NOW = 1_760_000_000;
const db = () => env.DB;

describe('memberStats', () => {
  beforeEach(async () => {
    for (const table of ['bracket_matches', 'signups', 'event_teams', 'announcements', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
    for (const p of ['host', '1', '2', '3', '4']) await upsertMember(db(), { discord_id: p, username: `p${p}`, avatar_hash: null }, NOW);
  });

  it('counts past events attended, tournaments played and won', async () => {
    const past = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 10, capacity: null, created_by: 'host' }, NOW);
    for (const p of ['1', '2', '3', '4']) await setSignup(db(), past, p, 'yes', NOW);
    await generateBracket(db(), past, NOW);
    const first = (await getBracket(db(), past)).filter((m) => m.round === 1);
    const winnerA = first[0].side_a!;
    const winnerB = first[1].side_a!;
    await setBracketWinner(db(), past, 1, 0, winnerA);
    await setBracketWinner(db(), past, 1, 1, winnerB);
    await setBracketWinner(db(), past, 2, 0, winnerA);
    const later = NOW + 86400; // the event is in the past by then
    const champion = winnerA.slice(2);
    const runnerUp = winnerB.slice(2);
    expect(await memberStats(db(), champion, later)).toMatchObject({ attended: 1, tournaments: 1, wins: 1, last_win: { title: 'Cup' }, member_since: null });
    expect(await memberStats(db(), runnerUp, later)).toMatchObject({ attended: 1, tournaments: 1, wins: 0, last_win: null });
    // Before the event happened, nothing counts yet.
    expect(await memberStats(db(), champion, NOW)).toMatchObject({ attended: 0, tournaments: 0, wins: 0 });
    // A plain signup with no bracket is an event attended, not a tournament.
    const social = await createEvent(db(), { title: 'Social', description: null, starts_at: NOW + 20, capacity: null, created_by: 'host' }, NOW);
    await setSignup(db(), social, champion, 'yes', NOW);
    expect(await memberStats(db(), champion, later)).toMatchObject({ attended: 2, tournaments: 1 });
    expect(await memberStats(db(), 'host', later)).toMatchObject({ attended: 0, first_event_at: null });
  });

  it('draws a card', async () => {
    const png = await profileCardPng('Valtteri', { attended: 12, tournaments: 4, wins: 1, first_event_at: NOW, last_win: { title: 'Autumn Cup', starts_at: NOW }, member_since: NOW - 86400 * 400 });
    expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(1000);
  });

  it('lists scheduled news once its time has come, and publishing clears it', async () => {
    const soon = await createAnnouncement(db(), { title: 'Meeting', body_md: 'Come', author_id: 'host', source: 'web', draft: true, publish_at: NOW + 60 }, NOW);
    await createAnnouncement(db(), { title: 'Later', body_md: 'x', author_id: 'host', source: 'web', draft: true, publish_at: NOW + 86400 }, NOW);
    await createAnnouncement(db(), { title: 'Plain draft', body_md: 'x', author_id: 'host', source: 'web', draft: true }, NOW);
    await createAnnouncement(db(), { title: 'Live', body_md: 'x', author_id: 'host', source: 'web', draft: false, publish_at: NOW - 5 }, NOW);
    expect((await listDueAnnouncements(db(), NOW)).map((a) => a.title)).toEqual([]);
    expect((await listDueAnnouncements(db(), NOW + 60)).map((a) => a.title)).toEqual(['Meeting']);
    await publishAnnouncement(db(), soon, NOW + 61);
    expect(await listDueAnnouncements(db(), NOW + 100)).toEqual([]);
  });
});
