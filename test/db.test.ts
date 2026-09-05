import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  ensureMember,
  createEvent,
  cancelEvent,
  uncancelEvent,
  setCancelMessageId,
  getEvent,
  setSignup,
  removeSignup,
  listSignups,
  RuleError,
} from '../src/lib/db';

// These run against a real (local) D1 with the production migrations
// applied by test/setup.ts — the signup rules are exercised on the actual
// schema, not mocks.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['signups', 'event_teams', 'events', 'announcements', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function seedMember(id: string, name = `user-${id}`): Promise<void> {
  await upsertMember(db(), { discord_id: id, username: name, avatar_hash: null }, NOW);
}

async function seedEvent(capacity: number | null): Promise<number> {
  await seedMember('admin');
  return createEvent(
    db(),
    {
      title: 'Test night',
      description: null,
      starts_at: NOW + 86400,
      capacity,
      created_by: 'admin',
    },
    NOW,
  );
}

beforeEach(wipe);

describe('setSignup capacity rule', () => {
  it('rejects a yes beyond capacity but still allows maybe', async () => {
    const eventId = await seedEvent(2);
    await seedMember('a');
    await seedMember('b');
    await seedMember('c');
    await setSignup(db(), eventId, 'a', 'yes', NOW);
    await setSignup(db(), eventId, 'b', 'yes', NOW);
    await expect(setSignup(db(), eventId, 'c', 'yes', NOW)).rejects.toMatchObject({ code: 'full' });
    await setSignup(db(), eventId, 'c', 'maybe', NOW);
    expect((await listSignups(db(), eventId)).length).toBe(3);
  });

  it('does not count your own existing yes against you when re-answering', async () => {
    const eventId = await seedEvent(1);
    await seedMember('a');
    await setSignup(db(), eventId, 'a', 'yes', NOW);
    // Changing yes -> yes or yes -> maybe must not trip the full check.
    await setSignup(db(), eventId, 'a', 'yes', NOW);
    await setSignup(db(), eventId, 'a', 'maybe', NOW);
    // The freed seat is takeable.
    await seedMember('b');
    await setSignup(db(), eventId, 'b', 'yes', NOW);
  });

  it('frees a seat when a signup is removed', async () => {
    const eventId = await seedEvent(1);
    await seedMember('a');
    await seedMember('b');
    await setSignup(db(), eventId, 'a', 'yes', NOW);
    await removeSignup(db(), eventId, 'a');
    await setSignup(db(), eventId, 'b', 'yes', NOW);
    expect((await listSignups(db(), eventId)).map((s) => s.discord_id)).toEqual(['b']);
  });
});

describe('setSignup duplicate rule', () => {
  it('keeps one row per member and updates the status in place', async () => {
    const eventId = await seedEvent(null);
    await seedMember('a');
    await setSignup(db(), eventId, 'a', 'yes', NOW);
    await setSignup(db(), eventId, 'a', 'maybe', NOW);
    const signups = await listSignups(db(), eventId);
    expect(signups.length).toBe(1);
    expect(signups[0].status).toBe('maybe');
  });
});

describe('cancelled events', () => {
  it('rejects signups to a cancelled event', async () => {
    const eventId = await seedEvent(null);
    await cancelEvent(db(), eventId, NOW);
    await seedMember('a');
    await expect(setSignup(db(), eventId, 'a', 'yes', NOW)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('rejects cancelling twice and unknown events', async () => {
    const eventId = await seedEvent(null);
    await cancelEvent(db(), eventId, NOW);
    await expect(cancelEvent(db(), eventId, NOW)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(cancelEvent(db(), 99999, NOW)).rejects.toMatchObject({ code: 'missing' });
  });

  it('rejects signup to an event that does not exist', async () => {
    await seedMember('a');
    await expect(setSignup(db(), 424242, 'a', 'yes', NOW)).rejects.toBeInstanceOf(RuleError);
  });
});

describe('member display cache', () => {
  it('upsertMember overwrites, ensureMember does not', async () => {
    await upsertMember(db(), { discord_id: 'x', username: 'Real Name', avatar_hash: 'h' }, NOW);
    await ensureMember(db(), 'x', 'placeholder', NOW + 1);
    const row = await db()
      .prepare('SELECT username FROM members WHERE discord_id = ?1')
      .bind('x')
      .first<{ username: string }>();
    expect(row!.username).toBe('Real Name');
    await upsertMember(db(), { discord_id: 'x', username: 'Renamed', avatar_hash: null }, NOW + 2);
    const renamed = await db()
      .prepare('SELECT username FROM members WHERE discord_id = ?1')
      .bind('x')
      .first<{ username: string }>();
    expect(renamed!.username).toBe('Renamed');
  });
});

describe('createEvent validation', () => {
  it('rejects an empty title and a non-positive capacity', async () => {
    await seedMember('admin');
    const base = {
      description: null,
      starts_at: NOW,
      created_by: 'admin',
    };
    await expect(
      createEvent(db(), { ...base, title: '   ', capacity: null }, NOW),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(
      createEvent(db(), { ...base, title: 'ok', capacity: 0 }, NOW),
    ).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('stores and reads an event back with counts', async () => {
    const eventId = await seedEvent(5);
    const event = await getEvent(db(), eventId);
    expect(event).toMatchObject({ title: 'Test night', capacity: 5, yes_count: 0, maybe_count: 0 });
  });
});

describe('reinstating a cancelled event', () => {
  it('clears the cancellation and remembers the Discord line only while cancelled', async () => {
    const eventId = await seedEvent(null);
    await expect(uncancelEvent(db(), eventId)).rejects.toMatchObject({ code: 'bad_input' });
    await cancelEvent(db(), eventId, NOW);
    await setCancelMessageId(db(), eventId, 'msg1');
    const before = await uncancelEvent(db(), eventId);
    expect(before.cancel_message_id).toBe('msg1');
    await setCancelMessageId(db(), eventId, null);
    expect(await getEvent(db(), eventId)).toMatchObject({ cancelled_at: null, cancel_message_id: null });
  });
});
