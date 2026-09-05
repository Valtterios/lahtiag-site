import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  updateEvent,
  getEvent,
  setSignup,
  createEventTeam,
  applyForMembership,
  decideApplication,
  signupAccess,
  createTicketType,
  updateTicketType,
  deleteTicketType,
  listTicketTypes,
  getTicketType,
  ticketOffer,
  createTicket,
  markTicketPaid,
  voidTicket,
  refundTicket,
  checkInTicket,
  undoCheckIn,
  getTicketByCode,
  listMyTickets,
  recordDoorPayment,
  listUnattachedDoorPayments,
  attachDoorPayment,
  salesSummary,
  listSignups,
  deleteEvent,
  PENDING_TICKET_SECONDS,
} from '../src/lib/db';
import { newTicketCode, normalizeTicketCode, codeFromScan, qrSvg } from '../src/lib/qr';
import { verifyWebhookSignature } from '../src/lib/stripe';

// Membership gating on events, reserved seats, ticket types and tickets
// against the real schema (migration 0011), plus the pure pieces: ticket
// codes, QR rendering, Stripe's webhook signature.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['door_payments', 'tickets', 'ticket_types', 'bracket_matches', 'signups', 'event_teams', 'events', 'register', 'members']) {
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

async function event(input: { capacity?: number | null; members_only?: boolean; member_slots?: number | null; team_size?: number | null } = {}): Promise<number> {
  await person('admin', false);
  return createEvent(
    db(),
    {
      title: 'LAN',
      description: null,
      starts_at: NOW + 7 * 86400,
      ends_at: NOW + 7 * 86400 + 3600,
      capacity: input.capacity ?? null,
      team_size: input.team_size ?? null,
      members_only: input.members_only ?? false,
      member_slots: input.member_slots ?? null,
      created_by: 'admin',
    },
    NOW,
  );
}

describe('members-only events and reserved seats', () => {
  it('lets only linked current members into a members-only event, on every signup path', async () => {
    const id = await event({ members_only: true });
    await person('m', true);
    await person('g', false);
    await setSignup(db(), id, 'm', 'yes', NOW);
    await expect(setSignup(db(), id, 'g', 'yes', NOW)).rejects.toMatchObject({ code: 'members_only' });
    await expect(setSignup(db(), id, 'g', 'maybe', NOW)).rejects.toMatchObject({ code: 'members_only' });
    const team = await event({ members_only: true, team_size: 2 });
    await expect(createEventTeam(db(), team, 'Guests', 'g', NOW)).rejects.toMatchObject({ code: 'members_only' });
    await createEventTeam(db(), team, 'Members', 'm', NOW);
  });

  it('keeps reserved seats for members and lets members use any seat', async () => {
    // capacity 3, 2 reserved: non-members get 1 seat
    const id = await event({ capacity: 3, member_slots: 2 });
    for (const [who, member] of [['g1', false], ['g2', false], ['m1', true], ['m2', true], ['m3', true]] as const) await person(who, member);
    expect(await signupAccess(db(), (await getEvent(db(), id))!, 'g1', true)).toMatchObject({ allowed: true, openSeatsLeft: 1 });
    await setSignup(db(), id, 'g1', 'yes', NOW);
    await expect(setSignup(db(), id, 'g2', 'yes', NOW)).rejects.toMatchObject({ code: 'reserved' });
    await setSignup(db(), id, 'g2', 'maybe', NOW); // maybe takes no seat
    await setSignup(db(), id, 'm1', 'yes', NOW);
    await setSignup(db(), id, 'm2', 'yes', NOW);
    await expect(setSignup(db(), id, 'm3', 'yes', NOW)).rejects.toMatchObject({ code: 'full' });
    // re-answering your own yes never counts against you
    await setSignup(db(), id, 'g1', 'yes', NOW);
    expect((await listSignups(db(), id)).filter((s) => s.status === 'yes').length).toBe(3);
  });

  it('validates the reserved seat count against the capacity', async () => {
    await person('admin', false);
    const base = { title: 'x', description: null, starts_at: NOW + 1000, capacity: 5, created_by: 'admin' };
    await expect(createEvent(db(), { ...base, member_slots: 6 }, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(createEvent(db(), { ...base, capacity: null, member_slots: 2 }, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    const id = await createEvent(db(), { ...base, member_slots: 5, members_only: true }, NOW);
    expect(await getEvent(db(), id)).toMatchObject({ members_only: 1, member_slots: 5 });
    await updateEvent(db(), id, { ...base, ends_at: null, organizers: null, link_url: null, members_only: false, member_slots: null });
    expect(await getEvent(db(), id)).toMatchObject({ members_only: 0, member_slots: null });
  });
});

describe('ticket types', () => {
  it('creates, updates, and deletes or deactivates depending on sales', async () => {
    const id = await event({ capacity: 10 });
    const typeId = await createTicketType(db(), id, { name: 'Standard', price_cents: 1000, member_price_cents: 500, members_only: false, quantity: 5, sales_close_at: null });
    await expect(createTicketType(db(), id, { name: 'Bad', price_cents: 500, member_price_cents: 600, members_only: false, quantity: null, sales_close_at: null })).rejects.toMatchObject({ code: 'bad_input' });
    await updateTicketType(db(), typeId, { name: 'Early bird', price_cents: 800, member_price_cents: null, members_only: true, quantity: null, sales_close_at: NOW + 100, active: true });
    expect(await getTicketType(db(), typeId)).toMatchObject({ name: 'Early bird', price_cents: 800, members_only: 1, sold: 0 });
    expect(await deleteTicketType(db(), typeId)).toBe('deleted');
    const again = await createTicketType(db(), id, { name: 'Standard', price_cents: 0, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    await createTicket(db(), { event_id: id, ticket_type_id: again, discord_id: null, holder_name: 'Walk In', amount_cents: 0, status: 'paid', source: 'door' }, NOW);
    expect(await deleteTicketType(db(), again)).toBe('deactivated');
    expect((await listTicketTypes(db(), id))[0]).toMatchObject({ active: 0, sold: 1 });
  });
});

describe('ticket offers', () => {
  async function setup(opts: Parameters<typeof event>[0] = { capacity: 2 }) {
    const id = await event(opts);
    await person('m', true);
    await person('g', false);
    const typeId = await createTicketType(db(), id, { name: 'Standard', price_cents: 1000, member_price_cents: 700, members_only: false, quantity: null, sales_close_at: null });
    return { id, typeId, ev: (await getEvent(db(), id))!, type: (await getTicketType(db(), typeId))! };
  }

  it('prices members and guests differently and stops at capacity, quantity, and sales close', async () => {
    const { id, typeId, ev, type } = await setup({ capacity: 2 });
    expect(await ticketOffer(db(), ev, type, 'm', NOW)).toEqual({ ok: true, amount_cents: 700, member: true });
    expect(await ticketOffer(db(), ev, type, 'g', NOW)).toEqual({ ok: true, amount_cents: 1000, member: false });
    expect(await ticketOffer(db(), ev, type, null, NOW)).toMatchObject({ ok: true, amount_cents: 1000 });
    await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'm', holder_name: 'M', amount_cents: 700, status: 'paid', source: 'online' }, NOW);
    expect(await ticketOffer(db(), ev, (await getTicketType(db(), typeId))!, 'm', NOW)).toEqual({ ok: false, reason: 'has_ticket' });
    await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'g', holder_name: 'G', amount_cents: 1000, status: 'pending', source: 'online' }, NOW);
    expect(await ticketOffer(db(), ev, (await getTicketType(db(), typeId))!, null, NOW)).toEqual({ ok: false, reason: 'full' });
    // a pending ticket older than the checkout window no longer holds its seat
    expect(await ticketOffer(db(), ev, (await getTicketType(db(), typeId))!, null, NOW + PENDING_TICKET_SECONDS + 1)).toMatchObject({ ok: true });
    expect(await ticketOffer(db(), ev, type, 'g', ev.starts_at)).toEqual({ ok: false, reason: 'sales_closed' });
  });

  it('honours members-only types, members-only events and reserved seats', async () => {
    const { id, ev } = await setup({ capacity: 2, member_slots: 1 });
    const membersType = await createTicketType(db(), id, { name: 'Member ticket', price_cents: 500, member_price_cents: null, members_only: true, quantity: null, sales_close_at: null });
    const mt = (await getTicketType(db(), membersType))!;
    expect(await ticketOffer(db(), ev, mt, 'g', NOW)).toEqual({ ok: false, reason: 'members_only' });
    expect(await ticketOffer(db(), ev, mt, 'm', NOW)).toMatchObject({ ok: true, amount_cents: 500 });
    // reserved seat: one guest seat, taken by a guest's paid ticket (a
    // ticketed event takes no plain signups)
    await person('g2', false);
    const std0 = (await listTicketTypes(db(), id)).find((t) => t.name === 'Standard')!;
    await createTicket(db(), { event_id: id, ticket_type_id: std0.id, discord_id: 'g2', holder_name: 'G2', amount_cents: 1000, status: 'paid', source: 'online' }, NOW);
    expect(await ticketOffer(db(), ev, mt, 'g', NOW)).toEqual({ ok: false, reason: 'members_only' });
    const std = (await listTicketTypes(db(), id)).find((t) => t.name === 'Standard')!;
    expect(await ticketOffer(db(), ev, std, 'g', NOW)).toEqual({ ok: false, reason: 'reserved' });
  });
});

describe('ticket lifecycle', () => {
  it('pending to paid adds the signup; refund removes it; check-in happens once', async () => {
    const id = await event({ capacity: 5 });
    await person('m', true);
    const typeId = await createTicketType(db(), id, { name: 'Standard', price_cents: 1000, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    const ticket = await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'm', holder_name: 'M', amount_cents: 1000, status: 'pending', source: 'online', stripe_session_id: 'cs_1' }, NOW);
    expect(ticket.code).toHaveLength(10);
    expect(await listSignups(db(), id)).toEqual([]);
    await expect(checkInTicket(db(), ticket.code, 'door', NOW)).rejects.toMatchObject({ code: 'not_paid' });
    // a second live ticket for the same account is refused, whatever its state
    await expect(createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'm', holder_name: 'M', amount_cents: 1000, status: 'pending', source: 'online' }, NOW)).rejects.toMatchObject({ code: 'has_ticket' });
    const paid = await markTicketPaid(db(), ticket.id, 'pi_1', 'M Typed', NOW + 60);
    expect(paid).toMatchObject({ status: 'paid', paid_at: NOW + 60, stripe_payment_intent: 'pi_1', holder_name: 'M Typed' });
    expect((await listSignups(db(), id)).map((s) => [s.discord_id, s.status])).toEqual([['m', 'yes']]);
    expect((await markTicketPaid(db(), ticket.id, 'pi_other', null, NOW + 999))?.paid_at).toBe(NOW + 60); // idempotent
    expect((await listMyTickets(db(), 'm')).map((t) => t.code)).toEqual([ticket.code]);
    const used = await checkInTicket(db(), ticket.code, 'door', NOW + 100);
    expect(used.checked_in_by).toBe('door');
    await expect(checkInTicket(db(), ticket.code, 'door', NOW + 101)).rejects.toMatchObject({ code: 'used' });
    await undoCheckIn(db(), ticket.id);
    expect((await getTicketByCode(db(), ticket.code))?.checked_in_at).toBeNull();
    expect(await salesSummary(db(), id)).toMatchObject({ tickets: 1, checked_in: 0, revenue_cents: 1000 });
    await refundTicket(db(), ticket.id);
    expect((await getTicketByCode(db(), ticket.code))?.status).toBe('refunded');
    expect(await listSignups(db(), id)).toEqual([]);
    expect(await salesSummary(db(), id)).toMatchObject({ tickets: 0, revenue_cents: 0 });
    // the account may buy again after a refund
    await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'm', holder_name: 'M', amount_cents: 1000, status: 'paid', source: 'online' }, NOW);
  });

  it('voids an abandoned checkout and attaches door payments to walk-ins', async () => {
    const id = await event({ capacity: 5 });
    const typeId = await createTicketType(db(), id, { name: 'Door', price_cents: 1000, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    const pending = await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: null, holder_name: 'Someone', amount_cents: 1000, status: 'pending', source: 'online', stripe_session_id: 'cs_2' }, NOW);
    expect(await voidTicket(db(), pending.id)).toBe(true);
    expect(await voidTicket(db(), pending.id)).toBe(false);
    expect((await getTicketByCode(db(), pending.code))?.status).toBe('void');
    // "Release this seat": the pending ticket blocked a second buy on the
    // account; void, the account may pick another type.
    await person('a', false);
    const held = await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'a', holder_name: 'A', amount_cents: 1000, status: 'pending', source: 'online', stripe_session_id: 'cs_3' }, NOW);
    const ev = (await getEvent(db(), id))!;
    const type = (await getTicketType(db(), typeId))!;
    expect(await ticketOffer(db(), ev, type, 'a', NOW)).toMatchObject({ ok: false, reason: 'has_ticket' });
    expect(await voidTicket(db(), held.id)).toBe(true);
    expect(await ticketOffer(db(), ev, type, 'a', NOW)).toMatchObject({ ok: true, amount_cents: 1000 });
    await recordDoorPayment(db(), 'pi_tap', 1000, NOW);
    await recordDoorPayment(db(), 'pi_tap', 1000, NOW); // idempotent
    expect((await listUnattachedDoorPayments(db(), NOW - 3600)).map((p) => p.stripe_payment_intent)).toEqual(['pi_tap']);
    const ticket = await attachDoorPayment(db(), 'pi_tap', id, typeId, 'Walk In', NOW + 5);
    expect(ticket).toMatchObject({ status: 'paid', source: 'door', holder_name: 'Walk In', stripe_payment_intent: 'pi_tap' });
    expect(await listUnattachedDoorPayments(db(), NOW - 3600)).toEqual([]);
    await expect(attachDoorPayment(db(), 'pi_tap', id, typeId, 'Again', NOW)).rejects.toMatchObject({ code: 'missing' });
    // deleting the event takes its tickets, types and door payments with it
    await deleteEvent(db(), id);
    expect(await getTicketByCode(db(), ticket.code)).toBeNull();
  });
});

describe('ticket codes and QR', () => {
  it('generates checked codes and normalises scans', () => {
    const code = newTicketCode();
    expect(normalizeTicketCode(code)).toBe(code);
    expect(normalizeTicketCode(code.toLowerCase())).toBe(code);
    expect(normalizeTicketCode(code.slice(0, 9) + (code[9] === 'A' ? 'B' : 'A'))).toBeNull();
    expect(normalizeTicketCode('nope')).toBeNull();
    expect(codeFromScan(`https://lahtiag.fi/tickets/${code}?x=1`)).toBe(code);
    expect(codeFromScan('https://example.com/other')).toBeNull();
    const svg = qrSvg(`https://lahtiag.fi/tickets/${code}`);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<path');
  });
});

describe('Stripe webhook signature', () => {
  async function sign(secret: string, t: number, payload: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
    return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('accepts a fresh valid signature and rejects tampering, staleness, and other secrets', async () => {
    const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
    const v1 = await sign('whsec_test', NOW, payload);
    expect(await verifyWebhookSignature('whsec_test', payload, `t=${NOW},v1=${v1}`, NOW + 10)).toBe(true);
    expect(await verifyWebhookSignature('whsec_test', payload, `t=${NOW},v1=deadbeef,v1=${v1}`, NOW + 10)).toBe(true);
    expect(await verifyWebhookSignature('whsec_test', payload + ' ', `t=${NOW},v1=${v1}`, NOW + 10)).toBe(false);
    expect(await verifyWebhookSignature('whsec_other', payload, `t=${NOW},v1=${v1}`, NOW + 10)).toBe(false);
    expect(await verifyWebhookSignature('whsec_test', payload, `t=${NOW},v1=${v1}`, NOW + 600)).toBe(false);
    expect(await verifyWebhookSignature('whsec_test', payload, null, NOW)).toBe(false);
  });
});

describe('ticketed team events', () => {
  it('lets only paid ticket holders form or join teams, and keeps signups tied to tickets', async () => {
    const id = await event({ capacity: 4, team_size: 2 });
    await person('a', true);
    await person('b', false);
    const typeId = await createTicketType(db(), id, { name: 'Entry', price_cents: 500, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    await expect(createEventTeam(db(), id, 'Alphas', 'a', NOW)).rejects.toMatchObject({ code: 'needs_ticket' });
    await expect(setSignup(db(), id, 'b', 'yes', NOW)).rejects.toMatchObject({ code: 'needs_ticket' });
    const ticket = await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: 'a', holder_name: 'A', amount_cents: 500, status: 'pending', source: 'online' }, NOW);
    await expect(createEventTeam(db(), id, 'Alphas', 'a', NOW)).rejects.toMatchObject({ code: 'needs_ticket' });
    await markTicketPaid(db(), ticket.id, 'pi_x', null, NOW);
    await createEventTeam(db(), id, 'Alphas', 'a', NOW);
    expect((await listSignups(db(), id)).map((s) => [s.discord_id, s.event_team_id !== null])).toEqual([['a', true]]);
    // leaving a ticketed event is a refund, not a click
    const { removeSignup } = await import('../src/lib/db');
    await expect(removeSignup(db(), id, 'a')).rejects.toMatchObject({ code: 'needs_ticket' });
    await refundTicket(db(), ticket.id);
    expect(await listSignups(db(), id)).toEqual([]);
  });
});
