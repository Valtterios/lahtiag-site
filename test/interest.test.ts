import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  getEvent,
  setSignup,
  setSignupsOpenAt,
  signupsOpen,
  toggleInterest,
  isInterested,
  listInterest,
  replaceDiscordInterest,
  ticketOffer,
  createTicketType,
  listTicketTypes,
} from '../src/lib/db';

// Signups that open later, and the Interested heart counted together
// with Discord's Interested clicks.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['event_interest', 'tickets', 'ticket_types', 'signups', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
}
async function seedEvent(): Promise<number> {
  await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
  await upsertMember(db(), { discord_id: '1', username: 'One', avatar_hash: null }, NOW);
  return createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400 * 7, capacity: null, created_by: 'host' }, NOW);
}

describe('signups open at', () => {
  beforeEach(wipe);

  it('holds signups and sales until the moment, then lets them through', async () => {
    const id = await seedEvent();
    await setSignupsOpenAt(db(), id, NOW + 3600);
    const event = (await getEvent(db(), id))!;
    expect(signupsOpen(event, NOW)).toBe(false);
    expect(signupsOpen(event, NOW + 3600)).toBe(true);
    await expect(setSignup(db(), id, '1', 'yes', NOW)).rejects.toMatchObject({ code: 'not_open' });
    await setSignup(db(), id, '1', 'yes', NOW + 3600);
    expect((await getEvent(db(), id))?.yes_count).toBe(1);

    await createTicketType(db(), id, { name: 'Entry', price_cents: 500, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    const type = (await listTicketTypes(db(), id))[0];
    expect(await ticketOffer(db(), event, type, null, NOW)).toEqual({ ok: false, reason: 'not_open' });
    expect((await ticketOffer(db(), event, type, null, NOW + 3600)).ok).toBe(true);
    await setSignupsOpenAt(db(), id, null);
    expect(signupsOpen((await getEvent(db(), id))!, NOW)).toBe(true);
  });
});

describe('the Interested heart', () => {
  beforeEach(wipe);

  it('toggles on the site, keeps Discord interest apart, counts each person once', async () => {
    const id = await seedEvent();
    expect(await toggleInterest(db(), id, '1', NOW)).toBe(true);
    expect(await isInterested(db(), id, '1')).toBe(true);
    expect((await getEvent(db(), id))?.interest_count).toBe(1);
    await replaceDiscordInterest(db(), id, ['1', '2', '3'], NOW + 5);
    expect((await getEvent(db(), id))?.interest_count).toBe(3);
    expect((await getEvent(db(), id))?.interest_synced_at).toBe(NOW + 5);
    expect(await toggleInterest(db(), id, '1', NOW + 6)).toBe(false); // the site heart is off, Discord's stays
    expect(await isInterested(db(), id, '1')).toBe(true);
    expect((await getEvent(db(), id))?.interest_count).toBe(3);
    await replaceDiscordInterest(db(), id, ['2'], NOW + 7);
    expect((await listInterest(db(), id)).map((r) => `${r.discord_id}:${r.source}`)).toEqual(['2:discord']);
    await expect(toggleInterest(db(), 999, '1', NOW)).rejects.toMatchObject({ code: 'missing' });
  });
});
