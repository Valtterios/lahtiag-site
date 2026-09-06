import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setSignup, cancelEvent, toggleInterest, joinWaitlist, listMyEvents } from '../src/lib/db';

// One list of everything a person has a stake in, strongest stake first.

const NOW = 1_760_000_000;
const db = () => env.DB;

describe('listMyEvents', () => {
  beforeEach(async () => {
    for (const table of ['event_waitlist', 'event_interest', 'signups', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
    await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
    await upsertMember(db(), { discord_id: 'me', username: 'Me', avatar_hash: null }, NOW);
    await upsertMember(db(), { discord_id: 'other', username: 'Other', avatar_hash: null }, NOW);
  });
  const make = (title: string, startsAt: number, capacity: number | null = null) =>
    createEvent(db(), { title, description: null, starts_at: startsAt, capacity, created_by: 'host' }, NOW);

  it('lists going, maybe, waitlist and interest, skipping past, cancelled and unrelated events', async () => {
    const going = await make('Going', NOW + 86400);
    await setSignup(db(), going, 'me', 'yes', NOW);
    await toggleInterest(db(), going, 'me', NOW); // interest too, but going wins
    const maybe = await make('Maybe', NOW + 86400 * 2);
    await setSignup(db(), maybe, 'me', 'maybe', NOW);
    const full = await make('Full', NOW + 86400 * 3, 1);
    await setSignup(db(), full, 'other', 'yes', NOW);
    await joinWaitlist(db(), full, 'me', NOW);
    const heart = await make('Heart', NOW + 86400 * 4);
    await toggleInterest(db(), heart, 'me', NOW);
    const past = await make('Past', NOW - 86400 * 2);
    await db().prepare('UPDATE events SET starts_at = ?2 WHERE id = ?1').bind(past, NOW - 86400 * 2).run();
    await db().prepare("INSERT INTO signups (event_id, discord_id, status, created_at) VALUES (?1, 'me', 'yes', ?2)").bind(past, NOW).run();
    const gone = await make('Cancelled', NOW + 86400 * 5);
    await setSignup(db(), gone, 'me', 'yes', NOW);
    await cancelEvent(db(), gone, NOW);
    await make('Unrelated', NOW + 86400 * 6);

    const mine = await listMyEvents(db(), 'me', NOW);
    expect(mine.map((e) => `${e.title}:${e.relation}`)).toEqual(['Going:going', 'Maybe:maybe', 'Full:waitlist', 'Heart:interested']);
    expect(await listMyEvents(db(), 'other', NOW)).toHaveLength(1);
  });
});
