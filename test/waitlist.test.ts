import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  updateEvent,
  getEvent,
  setSignup,
  removeSignup,
  adminRemoveSignup,
  joinWaitlist,
  leaveWaitlist,
  listWaitlist,
  waitlistPosition,
  promoteWaitlist,
  listUnannouncedPromotions,
  markPromotionsAnnounced,
  purgeMember,
  createTicketType,
} from '../src/lib/db';

// The waitlist of a full event: first come, first promoted.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['waitlist_promotions', 'event_waitlist', 'tickets', 'ticket_types', 'signups', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
}
async function seed(capacity: number | null, teamSize: number | null = null): Promise<number> {
  await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
  for (const p of ['1', '2', '3', '4']) await upsertMember(db(), { discord_id: p, username: `p${p}`, avatar_hash: null }, NOW);
  return createEvent(db(), { title: 'Night', description: null, starts_at: NOW + 86400, capacity, team_size: teamSize, created_by: 'host' }, NOW);
}
const base = (id: number) => ({ title: 'Night', description: null, starts_at: NOW + 86400, ends_at: null, organizers: null, link_url: null, capacity: 2 });

describe('waitlist', () => {
  beforeEach(wipe);

  it('takes people only when full, in order, and lets the first in when a seat frees', async () => {
    const id = await seed(2);
    await setSignup(db(), id, '1', 'yes', NOW);
    await expect(joinWaitlist(db(), id, '3', NOW)).rejects.toMatchObject({ code: 'not_full' });
    await setSignup(db(), id, '2', 'yes', NOW + 1);
    await expect(setSignup(db(), id, '3', 'yes', NOW + 2)).rejects.toMatchObject({ code: 'full' });
    await joinWaitlist(db(), id, '3', NOW + 2);
    await joinWaitlist(db(), id, '4', NOW + 3);
    await joinWaitlist(db(), id, '3', NOW + 4); // twice is once
    expect((await listWaitlist(db(), id)).map((w) => w.discord_id)).toEqual(['3', '4']);
    expect(await waitlistPosition(db(), id, '4')).toBe(2);
    expect(await waitlistPosition(db(), id, '1')).toBeNull();
    await expect(joinWaitlist(db(), id, '1', NOW)).rejects.toMatchObject({ code: 'duplicate' });

    await removeSignup(db(), id, '1');
    const event = await getEvent(db(), id);
    expect(event?.yes_count).toBe(2);
    expect((await listWaitlist(db(), id)).map((w) => w.discord_id)).toEqual(['4']);
    const pending = await listUnannouncedPromotions(db());
    expect(pending.map((p) => p.discord_id)).toEqual(['3']);
    await markPromotionsAnnounced(db(), pending.map((p) => p.id), NOW + 10);
    expect(await listUnannouncedPromotions(db())).toEqual([]);

    // The board removing someone, or raising the capacity, lets the next one in.
    await adminRemoveSignup(db(), id, '2');
    expect((await listWaitlist(db(), id)).length).toBe(0);
    expect((await getEvent(db(), id))?.yes_count).toBe(2);
    await leaveWaitlist(db(), id, '4'); // already promoted: a no-op
  });

  it('a raised capacity and a step back to maybe both promote', async () => {
    const id = await seed(1);
    await setSignup(db(), id, '1', 'yes', NOW);
    await joinWaitlist(db(), id, '2', NOW + 1);
    await joinWaitlist(db(), id, '3', NOW + 2);
    await updateEvent(db(), id, { ...base(id), capacity: 2 });
    expect((await listWaitlist(db(), id)).map((w) => w.discord_id)).toEqual(['3']);
    await setSignup(db(), id, '1', 'maybe', NOW + 5);
    expect((await listWaitlist(db(), id)).length).toBe(0);
    expect((await getEvent(db(), id))?.yes_count).toBe(2);
  });

  it('has no waitlist on team events, uncapped events or ticketed events; erasing someone frees their seat', async () => {
    const team = await seed(2, 2);
    await expect(joinWaitlist(db(), team, '1', NOW)).rejects.toMatchObject({ code: 'no_waitlist' });
    await wipe();
    const open = await seed(null);
    await expect(joinWaitlist(db(), open, '1', NOW)).rejects.toMatchObject({ code: 'no_waitlist' });
    await wipe();
    const ticketed = await seed(2);
    await createTicketType(db(), ticketed, { name: 'Entry', price_cents: 0, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    await expect(joinWaitlist(db(), ticketed, '1', NOW)).rejects.toMatchObject({ code: 'no_waitlist' });
    await wipe();
    const id = await seed(1);
    await setSignup(db(), id, '1', 'yes', NOW);
    await joinWaitlist(db(), id, '2', NOW + 1);
    await purgeMember(db(), '1');
    expect((await getEvent(db(), id))?.yes_count).toBe(1);
    expect((await listWaitlist(db(), id)).length).toBe(0);
    expect(await promoteWaitlist(db(), id, NOW)).toEqual([]);
  });
});
