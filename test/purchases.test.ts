import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  getEvent,
  applyForMembership,
  decideApplication,
  createTicketType,
  getTicketType,
  createTicket,
  listSignups,
  listMyTickets,
  getTicketByCode,
  adminRemoveSignup,
  repairTicketSignups,
  signupAccess,
  setEventCover,
  getEventCover,
  coverVersion,
  coverInfo,
  deleteEventCover,
  deleteEvent,
} from '../src/lib/db';
import {
  createProduct,
  updateProduct,
  listProducts,
  getProduct,
  productOffer,
  purchaseOffer,
  quoteLine,
  createPurchase,
  getPurchase,
  setPurchaseCheckout,
  markPurchasePaid,
  voidPurchase,
  refundPurchase,
  resumablePurchase,
  pendingPurchaseFor,
  purchaseTickets,
  purchaseItems,
  listUndeliveredItems,
  markItemDelivered,
  listMyItems,
  MAX_PER_PURCHASE,
  setProductImage,
  getProductImage,
  productImageInfo,
  productImageVersions,
  deleteProductImage,
} from '../src/lib/purchases';
import { parseBasket, serializeBasket, withLine, basketCount, writeBasket } from '../src/lib/basket';
import { parseAnswers } from '../src/lib/questions';
import { imageSize } from '../src/lib/images';
import { dailyMark, helsinkiDate } from '../src/lib/stamp';

// Purchases (migration 0015): the basket, tickets for friends by name,
// shop items, and what Stripe's verdict does to a whole purchase.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['product_images', 'event_covers', 'purchase_items', 'purchases', 'products', 'signup_answers', 'event_questions', 'door_payments', 'tickets', 'ticket_types', 'signups', 'event_teams', 'events', 'register', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}
beforeEach(wipe);

async function person(id: string, member: boolean): Promise<void> {
  await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
  if (member) {
    const entry = await applyForMembership(
      db(),
      {
        full_name: `Member ${id}`,
        domicile: 'Lahti',
        email: `${id}@example.com`,
        student_status: 'LUT',
        union_member: 'LTKY',
        telegram: null,
        discord_name: null,
        games: null,
        wants_active: false,
        message: null,
      },
      id,
      NOW,
    );
    await decideApplication(db(), entry, 'approve', 'board', NOW);
  }
}

async function event(input: { capacity?: number | null; members_only?: boolean; member_slots?: number | null } = {}): Promise<number> {
  await person('admin', false);
  return createEvent(
    db(),
    {
      title: 'LAN',
      description: null,
      starts_at: NOW + 7 * 86400,
      ends_at: NOW + 7 * 86400 + 3600,
      capacity: input.capacity ?? null,
      team_size: null,
      members_only: input.members_only ?? false,
      member_slots: input.member_slots ?? null,
      created_by: 'admin',
    },
    NOW,
  );
}

const buyer = (id: string) => ({ discordId: id, username: `user-${id}` });

describe('the basket', () => {
  it('parses, merges and caps lines; garbage is an empty basket', () => {
    expect(parseBasket(undefined)).toEqual([]);
    expect(parseBasket('nope')).toEqual([]);
    expect(parseBasket('[{"k":"t","i":3,"n":2},{"k":"p","i":1,"n":1},{"k":"t","i":3,"n":9},{"k":"x","i":1,"n":1}]')).toEqual([
      { kind: 'ticket', id: 3, count: 2 },
      { kind: 'item', id: 1, count: 1 },
    ]);
    let lines = withLine([], { kind: 'ticket', id: 3, count: 1 });
    lines = withLine(lines, { kind: 'ticket', id: 3, count: 2 });
    lines = withLine(lines, { kind: 'item', id: 1, count: 1 });
    expect(lines).toEqual([
      { kind: 'ticket', id: 3, count: 3 },
      { kind: 'item', id: 1, count: 1 },
    ]);
    expect(basketCount(lines)).toBe(4);
    expect(withLine(lines, { kind: 'ticket', id: 3, count: -3 })).toEqual([{ kind: 'item', id: 1, count: 1 }]);
    expect(withLine(lines, { kind: 'item', id: 1, count: 0 }, true)).toEqual([{ kind: 'ticket', id: 3, count: 3 }]);
    expect(parseBasket(serializeBasket(lines))).toEqual(lines);
  });

  it('deletes the cookie the way a __Host- cookie must be deleted', () => {
    const calls: { name: string; options: Record<string, unknown> }[] = [];
    const jar = {
      get: () => undefined,
      set: (name: string, _value: string, options: Record<string, unknown>) => calls.push({ name, options }),
      delete: (name: string, options: Record<string, unknown>) => calls.push({ name, options }),
    };
    writeBasket(jar, [{ kind: 'ticket', id: 1, count: 1 }]);
    writeBasket(jar, []);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.options).toMatchObject({ path: '/', secure: true });
  });

  it('reads answers under a per-ticket prefix', () => {
    const form = new FormData();
    form.set('l0_x1_q7', ' vegan ');
    const q = { id: 7, event_id: 1, label: 'Diet', kind: 'text' as const, options: '', required: 1, sort: 1 };
    expect(parseAnswers([q], form, 'l0_x1_q')).toEqual({ ok: true, answers: new Map([[7, 'vegan']]) });
    expect(parseAnswers([q], form, 'l0_x2_q')).toMatchObject({ ok: false });
  });
});

describe('products', () => {
  it('are created, priced for members, counted against stock', async () => {
    await person('m', true);
    await person('g', false);
    const id = await createProduct(db(), { name: 'Overall patch', description: 'Sewn.', price_cents: 500, member_price_cents: 300, stock: 3, active: true }, NOW);
    await expect(createProduct(db(), { name: '', description: '', price_cents: 500, member_price_cents: null, stock: null, active: true }, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    const product = (await getProduct(db(), id, NOW))!;
    expect(product).toMatchObject({ name: 'Overall patch', sold: 0 });
    expect(await productOffer(db(), product, 'm')).toMatchObject({ ok: true, unit_cents: 300, member: true, max: 3 });
    expect(await productOffer(db(), product, 'g')).toMatchObject({ ok: true, unit_cents: 500, member: false, max: 3 });
    expect(await productOffer(db(), product, null)).toMatchObject({ ok: true, unit_cents: 500, max: 3 });

    const bought = await createPurchase(db(), { buyer: buyer('g'), buyerName: '', status: 'paid', lines: [{ kind: 'item', product, quantity: 2 }] }, NOW);
    expect(bought.purchase).toMatchObject({ status: 'paid', total_cents: 1000, buyer_name: 'user-g' });
    expect(bought.items).toHaveLength(1);
    const after = (await getProduct(db(), id, NOW))!;
    expect(after.sold).toBe(2);
    expect(await productOffer(db(), after, null)).toMatchObject({ ok: true, max: 1 });
    await expect(createPurchase(db(), { buyer: null, buyerName: 'Walk In', status: 'paid', lines: [{ kind: 'item', product: after, quantity: 2 }] }, NOW)).rejects.toMatchObject({ code: 'sold_out' });
    // a failed purchase leaves nothing behind
    expect((await getProduct(db(), id, NOW))!.sold).toBe(2);

    await updateProduct(db(), id, { name: 'Overall patch', description: '', price_cents: 500, member_price_cents: null, stock: 3, active: false });
    expect(await listProducts(db(), NOW)).toEqual([]);
    expect(await listProducts(db(), NOW, true)).toHaveLength(1);

    // handing over
    const waiting = await listUndeliveredItems(db());
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ buyer_name: 'user-g', quantity: 2 });
    expect(await markItemDelivered(db(), waiting[0].id, 'board@x', NOW + 10)).toBe(true);
    expect(await markItemDelivered(db(), waiting[0].id, 'board@x', NOW + 10)).toBe(false);
    expect(await listUndeliveredItems(db())).toEqual([]);
    expect((await listMyItems(db(), 'g'))[0]).toMatchObject({ delivered_by: 'board@x' });
  });
});

describe('a purchase of tickets', () => {
  it('holds the buyer\'s own ticket at the member price and friends by name at the public price', async () => {
    await person('m', true);
    const id = await event({ capacity: 10 });
    const typeId = await createTicketType(db(), id, { name: 'Entry', price_cents: 1000, member_price_cents: 500, members_only: false, quantity: null, sales_close_at: null });
    const ev = (await getEvent(db(), id))!;
    const type = (await getTicketType(db(), typeId))!;
    const offer = await purchaseOffer(db(), ev, type, 'm', NOW);
    expect(offer).toMatchObject({ ok: true, member: true, own: { amount_cents: 500 }, extra_cents: 1000, max_extras: MAX_PER_PURCHASE - 1 });
    // no account: every ticket is by name
    expect(await purchaseOffer(db(), ev, type, null, NOW)).toMatchObject({ ok: true, own: null, extra_cents: 1000, max_extras: MAX_PER_PURCHASE });

    const quoted = await quoteLine(db(), { discordId: 'm' }, { kind: 'ticket', event: ev, type, ownTicket: true, extras: ['Anna', 'Ben'] }, NOW);
    expect(quoted).toMatchObject({ own_cents: 500, extra_cents: 1000, subtotal_cents: 2500, problem: null });

    const bought = await createPurchase(db(), { buyer: buyer('m'), buyerName: '', status: 'pending', lines: [{ kind: 'ticket', event: ev, type, ownTicket: true, extras: ['Anna', 'Ben'] }] }, NOW);
    expect(bought.purchase).toMatchObject({ status: 'pending', total_cents: 2500 });
    expect(bought.tickets.map((t) => [t.holder_name, t.discord_id, t.bought_by, t.amount_cents])).toEqual([
      ['user-m', 'm', null, 500],
      ['Anna', null, 'm', 1000],
      ['Ben', null, 'm', 1000],
    ]);
    // pending holds the seats; the buyer may not start a second own ticket
    expect(await purchaseOffer(db(), ev, type, 'm', NOW)).toMatchObject({ ok: true, own: null });
    expect(await pendingPurchaseFor(db(), 'm', NOW)).toMatchObject({ id: bought.purchase.id });
    await setPurchaseCheckout(db(), bought.purchase.id, 'cs_1', 'https://checkout.stripe.com/x');
    expect(resumablePurchase(await getPurchase(db(), bought.purchase.id), NOW + 60)).toBe('https://checkout.stripe.com/x');
    expect(resumablePurchase(await getPurchase(db(), bought.purchase.id), NOW + 3600)).toBeNull();
    expect((await purchaseTickets(db(), bought.purchase.id)).every((t) => t.stripe_session_id === 'cs_1')).toBe(true);

    // paid: every ticket is paid, the buyer's own is their signup, friends are not signups
    await markPurchasePaid(db(), bought.purchase.id, 'pi_1', NOW + 100);
    expect((await getPurchase(db(), bought.purchase.id))!).toMatchObject({ status: 'paid', stripe_payment_intent: 'pi_1' });
    expect((await purchaseTickets(db(), bought.purchase.id)).map((t) => t.status)).toEqual(['paid', 'paid', 'paid']);
    expect((await listSignups(db(), id)).map((s) => s.discord_id)).toEqual(['m']);
    // the buyer sees all three under My tickets
    expect((await listMyTickets(db(), 'm')).map((t) => t.holder_name)).toEqual(['user-m', 'Anna', 'Ben']);

    // an admin cannot drop a paid ticket holder from the roster, and a lost signup comes back
    await expect(adminRemoveSignup(db(), id, 'm')).rejects.toMatchObject({ code: 'ticket_holder' });
    await db().prepare('DELETE FROM signups WHERE event_id = ?1').bind(id).run();
    expect(await repairTicketSignups(db(), id, NOW + 200)).toBe(1);
    expect((await listSignups(db(), id)).map((s) => s.discord_id)).toEqual(['m']);

    // a full refund kills the whole purchase
    await refundPurchase(db(), bought.purchase.id);
    expect((await getPurchase(db(), bought.purchase.id))!.status).toBe('refunded');
    expect((await purchaseTickets(db(), bought.purchase.id)).map((t) => t.status)).toEqual(['refunded', 'refunded', 'refunded']);
    expect(await listSignups(db(), id)).toEqual([]);
  });

  it('keeps friends out of reserved seats and members-only types, and voids a released purchase', async () => {
    await person('m', true);
    await person('g', false);
    const id = await event({ capacity: 4, member_slots: 2 });
    const typeId = await createTicketType(db(), id, { name: 'Entry', price_cents: 1000, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    const membersId = await createTicketType(db(), id, { name: 'Members', price_cents: 0, member_price_cents: null, members_only: true, quantity: null, sales_close_at: null });
    const ev = (await getEvent(db(), id))!;
    const type = (await getTicketType(db(), typeId))!;
    const members = (await getTicketType(db(), membersId))!;
    // 4 seats, 2 reserved: friends (never members) get at most 2
    expect(await purchaseOffer(db(), ev, type, 'm', NOW)).toMatchObject({ ok: true, own: { amount_cents: 1000 }, max_extras: 2 });
    expect(await purchaseOffer(db(), ev, members, 'm', NOW)).toMatchObject({ ok: true, own: { amount_cents: 0 }, extra_cents: null, max_extras: 0 });
    expect(await purchaseOffer(db(), ev, members, 'g', NOW)).toMatchObject({ ok: false, reason: 'members_only' });
    await expect(
      createPurchase(db(), { buyer: buyer('m'), buyerName: '', status: 'pending', lines: [{ kind: 'ticket', event: ev, type, ownTicket: true, extras: ['A', 'B', 'C'] }] }, NOW),
    ).rejects.toMatchObject({ code: 'sold_out' });
    expect(await listMyTickets(db(), 'm')).toEqual([]);

    // two by-name tickets take the open seats: a non-member is then told the rest are reserved
    const bought = await createPurchase(db(), { buyer: null, buyerName: 'Walk', status: 'pending', lines: [{ kind: 'ticket', event: ev, type, ownTicket: false, extras: ['A', 'B'] }] }, NOW);
    expect(bought.purchase).toMatchObject({ buyer_name: 'Walk', total_cents: 2000 });
    expect((await signupAccess(db(), ev, 'g', true, NOW)).openSeatsLeft).toBe(0);
    expect(await purchaseOffer(db(), ev, type, 'g', NOW)).toMatchObject({ ok: false, reason: 'reserved' });
    expect(await purchaseOffer(db(), ev, type, 'm', NOW)).toMatchObject({ ok: true, own: { amount_cents: 1000 }, max_extras: 0 });

    // released: the seats are free again
    expect(await voidPurchase(db(), bought.purchase.id)).toBe(true);
    expect(await voidPurchase(db(), bought.purchase.id)).toBe(false);
    expect((await getTicketByCode(db(), bought.tickets[0].code))!.status).toBe('void');
    expect(await purchaseOffer(db(), ev, type, 'g', NOW)).toMatchObject({ ok: true, own: { amount_cents: 1000 }, max_extras: 1 });

    // a free purchase is issued paid at once, and the buyer's own ticket is their signup
    const free = await createPurchase(db(), { buyer: buyer('m'), buyerName: '', status: 'paid', lines: [{ kind: 'ticket', event: ev, type: members, ownTicket: true, extras: [] }] }, NOW);
    expect(free.purchase).toMatchObject({ status: 'paid', total_cents: 0 });
    expect((await listSignups(db(), id)).map((s) => s.discord_id)).toEqual(['m']);
    // and a second own ticket for the same event is refused
    await expect(
      createPurchase(db(), { buyer: buyer('m'), buyerName: '', status: 'paid', lines: [{ kind: 'ticket', event: ev, type, ownTicket: true, extras: [] }] }, NOW),
    ).rejects.toMatchObject({ code: 'has_ticket' });
    expect(await purchaseItems(db(), free.purchase.id)).toEqual([]);
    // legacy: a ticket outside any purchase still lists
    await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'g', holder_name: 'G', amount_cents: 1000, status: 'paid', source: 'online' }, NOW);
    expect((await listMyTickets(db(), 'g')).map((t) => t.purchase_id)).toEqual([null]);
  });
});

describe('event covers', () => {
  it('stores one image per event, replaces it, and goes with the event', async () => {
    const id = await event();
    // a PNG header claiming 680 × 240
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 168, 0, 0, 0, 240, 8, 6, 0, 0, 0]).buffer;
    await expect(setEventCover(db(), id, 'image/gif', png, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(setEventCover(db(), id, 'image/png', new ArrayBuffer(0), NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(setEventCover(db(), 999, 'image/png', png, NOW)).rejects.toMatchObject({ code: 'missing' });
    expect(await coverVersion(db(), id)).toBeNull();
    await setEventCover(db(), id, 'image/png', png, NOW);
    expect(await coverVersion(db(), id)).toBe(NOW);
    expect(await coverInfo(db(), id)).toMatchObject({ width: 680, height: 240 });
    const stored = (await getEventCover(db(), id))!;
    expect(stored.content_type).toBe('image/png');
    expect(new Uint8Array(stored.bytes)).toEqual(new Uint8Array(png));
    await setEventCover(db(), id, 'image/webp', png, NOW + 5);
    expect(await coverVersion(db(), id)).toBe(NOW + 5);
    expect(await deleteEventCover(db(), id)).toBe(true);
    expect(await deleteEventCover(db(), id)).toBe(false);
    await setEventCover(db(), id, 'image/jpeg', png, NOW + 9);
    await deleteEvent(db(), id);
    expect(await getEventCover(db(), id)).toBeNull();
  });
});

describe('event location', () => {
  it('is stored, edited and capped', async () => {
    await person('admin', false);
    const id = await createEvent(db(), { title: 'LAN', description: null, starts_at: NOW + 86400, ends_at: null, capacity: null, team_size: null, location: '  Mukkulankatu 19 ', created_by: 'admin' }, NOW);
    expect((await getEvent(db(), id))!.location).toBe('Mukkulankatu 19');
    await expect(
      createEvent(db(), { title: 'LAN', description: null, starts_at: NOW + 86400, ends_at: null, capacity: null, team_size: null, location: 'x'.repeat(121), created_by: 'admin' }, NOW),
    ).rejects.toMatchObject({ code: 'bad_input' });
  });
});

describe('image headers', () => {
  it('reads the pixel size of PNG, JPEG and WebP, and rejects the rest', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 176, 0, 0, 2, 118, 8, 6, 0, 0, 0]).buffer;
    expect(imageSize(png)).toEqual({ width: 1200, height: 630 });
    // JPEG: SOI, an APP0 segment, then SOF0 with height 630 and width 1200
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 2, 118, 4, 176, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]).buffer;
    expect(imageSize(jpeg)).toEqual({ width: 1200, height: 630 });
    // WebP VP8X: canvas size minus one, little-endian 24-bit
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 0xaf, 4, 0, 0x75, 2, 0]).buffer;
    expect(imageSize(webp)).toEqual({ width: 1200, height: 630 });
    expect(imageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]).buffer)).toBeNull();
  });
});

describe('product images', () => {
  it('stores one picture per product with its size', async () => {
    const id = await createProduct(db(), { name: 'Patch', description: '', price_cents: 500, member_price_cents: null, stock: null, active: true }, NOW);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 3, 32, 0, 0, 3, 32, 8, 6, 0, 0, 0]).buffer;
    await expect(setProductImage(db(), 999, 'image/png', png, NOW)).rejects.toMatchObject({ code: 'missing' });
    await expect(setProductImage(db(), id, 'image/png', new Uint8Array([1, 2, 3]).buffer, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await setProductImage(db(), id, 'image/png', png, NOW);
    expect(await productImageInfo(db(), id)).toMatchObject({ width: 800, height: 800, updated_at: NOW });
    expect(await productImageVersions(db(), [id, 999])).toEqual(new Map([[id, NOW]]));
    expect(new Uint8Array((await getProductImage(db(), id))!.bytes)).toEqual(new Uint8Array(png));
    expect(await deleteProductImage(db(), id)).toBe(true);
    expect(await productImageInfo(db(), id)).toBeNull();
  });
});

describe('the mark of the day', () => {
  it('is the same all day in Helsinki and differs by secret', async () => {
    const day = Date.UTC(2026, 8, 5, 10) / 1000; // 13:00 Helsinki
    expect(helsinkiDate(day)).toBe('2026-09-05');
    expect(helsinkiDate(Date.UTC(2026, 8, 5, 21, 30) / 1000)).toBe('2026-09-06'); // 00:30 the next day in Helsinki
    const a = await dailyMark('secret-a', day);
    expect(await dailyMark('secret-a', day + 3600 * 5)).toEqual(a);
    expect(a.icon.length).toBeGreaterThan(0);
    const days = new Set<string>();
    for (let d = 0; d < 30; d++) days.add((await dailyMark('secret-a', day + d * 86400)).name);
    expect(days.size).toBeGreaterThan(5);
    const other = [];
    for (let d = 0; d < 10; d++) other.push((await dailyMark('secret-b', day + d * 86400)).name === (await dailyMark('secret-a', day + d * 86400)).name);
    expect(other.every(Boolean)).toBe(false);
  });
});
