// Buying things: one purchase groups tickets (for one or several events,
// for the buyer and for friends by name) and shop items, paid in one
// Checkout. The basket (basket.ts) says what; this prices it, creates it,
// and follows Stripe's verdict on it. Tickets themselves stay in db.ts.

import type { D1Database } from '@cloudflare/workers-types';
import { newTicketCode } from './qr';
import { imageSize } from './images';
import {
  RuleError,
  PENDING_TICKET_SECONDS,
  ticketOffer,
  signupAccess,
  countLiveTickets,
  createTicket,
  markTicketPaid,
  voidTicket,
  refundTicket,
  isCurrentMember,
  listTicketsByPurchase,
  blobBytes,
  COVER_TYPES,
  COVER_MAX_BYTES,
  type EventRow,
  type TicketTypeWithSales,
  type TicketRow,
  type TicketWithType,
} from './db';

// Tickets of one type in one purchase (the buyer's own plus friends), and
// pieces of one shop item.
export const MAX_PER_PURCHASE = 6;
export const MAX_ITEM_QUANTITY = 10;

export interface PurchaseRow {
  id: string;
  discord_id: string | null;
  buyer_name: string;
  status: 'pending' | 'paid' | 'refunded' | 'void';
  total_cents: number;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  checkout_url: string | null;
  created_at: number;
  paid_at: number | null;
}

export interface ProductRow {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  member_price_cents: number | null;
  stock: number | null; // null: not counted
  active: number;
  sort: number;
  created_at: number;
}

export interface ProductWithSales extends ProductRow {
  sold: number; // paid, plus pending purchases still inside their window
}

export interface PurchaseItemRow {
  id: number;
  purchase_id: string;
  product_id: number;
  name: string;
  quantity: number;
  unit_cents: number;
  delivered_at: number | null;
  delivered_by: string | null;
}

// --- products --------------------------------------------------------------------

const PRODUCT_SELECT = `SELECT p.*,
  (SELECT COALESCE(SUM(i.quantity), 0) FROM purchase_items i JOIN purchases u ON u.id = i.purchase_id
     WHERE i.product_id = p.id AND (u.status = 'paid' OR (u.status = 'pending' AND u.created_at > ?1))) AS sold
  FROM products p`;

export async function listProducts(db: D1Database, now: number, all = false): Promise<ProductWithSales[]> {
  const { results } = await db
    .prepare(`${PRODUCT_SELECT} ${all ? '' : 'WHERE p.active = 1'} ORDER BY p.active DESC, p.sort, p.id`)
    .bind(now - PENDING_TICKET_SECONDS)
    .all<ProductWithSales>();
  return results;
}

export async function getProduct(db: D1Database, id: number, now: number): Promise<ProductWithSales | null> {
  return db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?2`).bind(now - PENDING_TICKET_SECONDS, id).first<ProductWithSales>();
}

export interface ProductInput {
  name: string;
  description: string;
  price_cents: number;
  member_price_cents: number | null;
  stock: number | null;
  active: boolean;
}

function checkProductInput(input: ProductInput): void {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new RuleError('bad_input', 'A product name is 1 to 80 characters.');
  if (input.description.length > 600) throw new RuleError('bad_input', 'The description is at most 600 characters.');
  const price = (n: number | null) => n === null || (Number.isInteger(n) && n >= 0 && n <= 100_000_00);
  if (!price(input.price_cents) || !price(input.member_price_cents)) throw new RuleError('bad_input', 'Prices are whole cents, 0 or more.');
  if (input.stock !== null && (!Number.isInteger(input.stock) || input.stock < 0 || input.stock > 100_000)) {
    throw new RuleError('bad_input', 'Stock is a whole number, or empty for uncounted.');
  }
}

export async function createProduct(db: D1Database, input: ProductInput, now: number): Promise<number> {
  checkProductInput(input);
  const last = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM products').first<{ s: number }>();
  const row = await db
    .prepare(
      `INSERT INTO products (name, description, price_cents, member_price_cents, stock, active, sort, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
    )
    .bind(input.name.trim(), input.description.trim(), input.price_cents, input.member_price_cents, input.stock, input.active ? 1 : 0, (last?.s ?? 0) + 1, now)
    .first<{ id: number }>();
  return row!.id;
}

export async function updateProduct(db: D1Database, id: number, input: ProductInput): Promise<void> {
  checkProductInput(input);
  const result = await db
    .prepare(
      `UPDATE products SET name = ?2, description = ?3, price_cents = ?4, member_price_cents = ?5, stock = ?6, active = ?7 WHERE id = ?1`,
    )
    .bind(id, input.name.trim(), input.description.trim(), input.price_cents, input.member_price_cents, input.stock, input.active ? 1 : 0)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new RuleError('missing', `No product with id ${id}.`);
}

// What this person pays per piece, and how many they may take.
export async function productOffer(
  db: D1Database,
  product: ProductWithSales,
  discordId: string | null,
): Promise<{ ok: true; unit_cents: number; member: boolean; max: number } | { ok: false; reason: RuleError['code'] }> {
  if (product.active !== 1) return { ok: false, reason: 'sales_closed' };
  const left = product.stock === null ? MAX_ITEM_QUANTITY : product.stock - product.sold;
  if (left <= 0) return { ok: false, reason: 'sold_out' };
  const member = discordId ? await isCurrentMember(db, discordId) : false;
  const unit = member && product.member_price_cents !== null ? product.member_price_cents : product.price_cents;
  return { ok: true, unit_cents: unit, member, max: Math.min(left, MAX_ITEM_QUANTITY) };
}

// --- product images ----------------------------------------------------------------

export interface ProductImageInfo {
  updated_at: number;
  width: number;
  height: number;
}

export async function productImageInfo(db: D1Database, productId: number): Promise<ProductImageInfo | null> {
  return db.prepare('SELECT updated_at, width, height FROM product_images WHERE product_id = ?1').bind(productId).first<ProductImageInfo>();
}

// Versions for a whole list at once (the shop page, the checkout).
export async function productImageVersions(db: D1Database, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(`SELECT product_id, updated_at FROM product_images WHERE product_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})`)
    .bind(...ids)
    .all<{ product_id: number; updated_at: number }>();
  for (const row of results) out.set(row.product_id, row.updated_at);
  return out;
}

export async function getProductImage(db: D1Database, productId: number): Promise<{ content_type: string; bytes: ArrayBuffer; updated_at: number } | null> {
  const row = await db
    .prepare('SELECT content_type, bytes, updated_at FROM product_images WHERE product_id = ?1')
    .bind(productId)
    .first<{ content_type: string; bytes: unknown; updated_at: number }>();
  return row ? { content_type: row.content_type, bytes: blobBytes(row.bytes), updated_at: row.updated_at } : null;
}

export async function setProductImage(db: D1Database, productId: number, contentType: string, bytes: ArrayBuffer, now: number): Promise<void> {
  if (!(COVER_TYPES as readonly string[]).includes(contentType)) throw new RuleError('bad_input', 'JPEG, PNG or WebP only.');
  if (bytes.byteLength === 0 || bytes.byteLength > COVER_MAX_BYTES) throw new RuleError('bad_input', 'The image is empty or over 1.5 MB.');
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1) throw new RuleError('bad_input', 'That file is not a readable image.');
  const product = await db.prepare('SELECT id FROM products WHERE id = ?1').bind(productId).first();
  if (!product) throw new RuleError('missing', `No product with id ${productId}.`);
  await db
    .prepare(
      `INSERT INTO product_images (product_id, content_type, bytes, size, width, height, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (product_id) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes, size = excluded.size,
         width = excluded.width, height = excluded.height, updated_at = excluded.updated_at`,
    )
    .bind(productId, contentType, bytes, bytes.byteLength, size.width, size.height, now)
    .run();
}

export async function deleteProductImage(db: D1Database, productId: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM product_images WHERE product_id = ?1').bind(productId).run();
  return (result.meta.changes ?? 0) > 0;
}

// --- what a purchase of tickets may contain --------------------------------------

// `own` is the signed-in buyer's ticket at their price: null when they
// already hold one for the event, and always null without an account
// (then every ticket is by name). Extras are tickets by name for other
// people at the public price, never members' seats; a members-only type
// sells none. `max_extras` is the seats left for them right now.
export type PurchaseOffer =
  | { ok: false; reason: RuleError['code'] }
  | { ok: true; member: boolean; own: { amount_cents: number } | null; extra_cents: number | null; max_extras: number };

export async function purchaseOffer(
  db: D1Database,
  event: EventRow,
  type: TicketTypeWithSales,
  discordId: string | null,
  now: number,
): Promise<PurchaseOffer> {
  const base = await ticketOffer(db, event, type, discordId, now);
  if (!base.ok && base.reason !== 'has_ticket') return base;
  const own = base.ok && discordId ? { amount_cents: base.amount_cents } : null;
  const member = base.ok ? base.member : (await signupAccess(db, event, discordId, false, now)).member;
  const closedToExtras = type.members_only === 1 || event.members_only === 1;

  let seats = MAX_PER_PURCHASE;
  if (type.quantity !== null) seats = Math.min(seats, type.quantity - type.sold);
  if (event.capacity !== null && event.team_size === null) {
    seats = Math.min(seats, event.capacity - (await countLiveTickets(db, event.id, now)));
  }
  const guest = await signupAccess(db, event, null, false, now);
  let extras = seats - (own ? 1 : 0);
  // A non-member buyer's own ticket takes one of the open seats too.
  if (guest.openSeatsLeft !== null) extras = Math.min(extras, guest.openSeatsLeft - (own && !member ? 1 : 0));
  if (closedToExtras) extras = 0;
  extras = Math.max(0, extras);

  if (!own && extras === 0) {
    if (!base.ok) return { ok: false, reason: base.reason };
    if (closedToExtras) return { ok: false, reason: 'members_only' };
    return { ok: false, reason: seats > 0 && guest.openSeatsLeft === 0 ? 'reserved' : 'sold_out' };
  }
  return { ok: true, member, own, extra_cents: closedToExtras ? null : type.price_cents, max_extras: extras };
}

// --- pricing a basket ------------------------------------------------------------

export type PurchaseLine =
  | { kind: 'ticket'; event: EventRow; type: TicketTypeWithSales; ownTicket: boolean; extras: string[] }
  | { kind: 'item'; product: ProductWithSales; quantity: number };

export type QuotedLine =
  | {
      kind: 'ticket';
      event: EventRow;
      type: TicketTypeWithSales;
      ownTicket: boolean;
      own_cents: number | null;
      extras: string[];
      extra_cents: number | null;
      max_extras: number;
      subtotal_cents: number;
      problem: RuleError['code'] | null;
    }
  | { kind: 'item'; product: ProductWithSales; quantity: number; unit_cents: number; max: number; subtotal_cents: number; problem: RuleError['code'] | null };

// Prices one line for this buyer as things stand now. A problem is
// reported, not thrown, so the checkout page can show it in place.
export async function quoteLine(db: D1Database, buyer: { discordId: string } | null, line: PurchaseLine, now: number): Promise<QuotedLine> {
  if (line.kind === 'item') {
    const offer = await productOffer(db, line.product, buyer?.discordId ?? null);
    if (!offer.ok) return { ...line, unit_cents: line.product.price_cents, max: 0, subtotal_cents: 0, problem: offer.reason };
    const problem = line.quantity > offer.max ? 'sold_out' : line.quantity < 1 ? 'bad_input' : null;
    return { ...line, unit_cents: offer.unit_cents, max: offer.max, subtotal_cents: offer.unit_cents * line.quantity, problem };
  }
  const offer = await purchaseOffer(db, line.event, line.type, buyer?.discordId ?? null, now);
  if (!offer.ok) {
    return { ...line, own_cents: null, extra_cents: null, max_extras: 0, subtotal_cents: 0, problem: offer.reason };
  }
  let problem: RuleError['code'] | null = null;
  if (line.ownTicket && !offer.own) problem = 'has_ticket';
  else if (line.extras.length > offer.max_extras) problem = offer.extra_cents === null ? 'members_only' : 'sold_out';
  else if (!line.ownTicket && line.extras.length === 0) problem = 'bad_input';
  const ownCents = line.ownTicket && offer.own ? offer.own.amount_cents : null;
  const subtotal = (ownCents ?? 0) + (offer.extra_cents ?? 0) * line.extras.length;
  return { ...line, own_cents: ownCents, extra_cents: offer.extra_cents, max_extras: offer.max_extras, subtotal_cents: subtotal, problem };
}

// --- the purchase itself ---------------------------------------------------------

export async function getPurchase(db: D1Database, id: string): Promise<PurchaseRow | null> {
  return db.prepare('SELECT * FROM purchases WHERE id = ?1').bind(id).first<PurchaseRow>();
}

export async function getPurchaseBySession(db: D1Database, sessionId: string): Promise<PurchaseRow | null> {
  return db.prepare('SELECT * FROM purchases WHERE stripe_session_id = ?1').bind(sessionId).first<PurchaseRow>();
}

export async function getPurchaseByPaymentIntent(db: D1Database, paymentIntent: string): Promise<PurchaseRow | null> {
  return db.prepare('SELECT * FROM purchases WHERE stripe_payment_intent = ?1').bind(paymentIntent).first<PurchaseRow>();
}

export async function purchaseTickets(db: D1Database, id: string): Promise<TicketWithType[]> {
  return listTicketsByPurchase(db, id);
}

export async function purchaseItems(db: D1Database, id: string): Promise<PurchaseItemRow[]> {
  const { results } = await db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?1 ORDER BY id').bind(id).all<PurchaseItemRow>();
  return results;
}

// Creates the purchase and everything in it, re-pricing every line first
// so two buyers racing for the last seats or the last patch do not both
// get them. A line that fails undoes the whole purchase and throws.
export async function createPurchase(
  db: D1Database,
  input: {
    buyer: { discordId: string; username: string } | null;
    buyerName: string;
    status: 'pending' | 'paid';
    lines: PurchaseLine[];
  },
  now: number,
): Promise<{ purchase: PurchaseRow; tickets: TicketRow[]; items: PurchaseItemRow[] }> {
  if (input.lines.length === 0) throw new RuleError('bad_input', 'Nothing to buy.');
  const id = newTicketCode();
  const buyerName = input.buyerName.replace(/\s+/g, ' ').trim().slice(0, 60) || input.buyer?.username || 'Buyer';
  await db
    .prepare(
      `INSERT INTO purchases (id, discord_id, buyer_name, status, total_cents, created_at, paid_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`,
    )
    .bind(id, input.buyer?.discordId ?? null, buyerName, input.status, now, input.status === 'paid' ? now : null)
    .run();
  const tickets: TicketRow[] = [];
  const items: PurchaseItemRow[] = [];
  let total = 0;
  try {
    for (const line of input.lines) {
      const quoted = await quoteLine(db, input.buyer, line, now);
      if (quoted.problem) throw new RuleError(quoted.problem, 'Not available as asked.');
      if (quoted.kind === 'item') {
        const row = await db
          .prepare(
            `INSERT INTO purchase_items (purchase_id, product_id, name, quantity, unit_cents) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *`,
          )
          .bind(id, quoted.product.id, quoted.product.name, quoted.quantity, quoted.unit_cents)
          .first<PurchaseItemRow>();
        items.push(row!);
        total += quoted.subtotal_cents;
        continue;
      }
      const source = input.buyer ? 'online' : 'door';
      if (quoted.ownTicket && input.buyer && quoted.own_cents !== null) {
        tickets.push(
          await createTicket(
            db,
            {
              event_id: quoted.event.id,
              ticket_type_id: quoted.type.id,
              discord_id: input.buyer.discordId,
              holder_name: input.buyer.username,
              amount_cents: quoted.own_cents,
              status: input.status,
              source,
              purchase_id: id,
            },
            now,
          ),
        );
      }
      for (const name of quoted.extras) {
        tickets.push(
          await createTicket(
            db,
            {
              event_id: quoted.event.id,
              ticket_type_id: quoted.type.id,
              discord_id: null,
              holder_name: name,
              amount_cents: quoted.extra_cents ?? 0,
              status: input.status,
              source,
              bought_by: input.buyer?.discordId ?? null,
              purchase_id: id,
            },
            now,
          ),
        );
      }
      total += quoted.subtotal_cents;
    }
  } catch (error) {
    await db.prepare('DELETE FROM signup_answers WHERE ticket_id IN (SELECT id FROM tickets WHERE purchase_id = ?1)').bind(id).run();
    await db.prepare('DELETE FROM tickets WHERE purchase_id = ?1').bind(id).run();
    await db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?1').bind(id).run();
    await db.prepare('DELETE FROM purchases WHERE id = ?1').bind(id).run();
    throw error;
  }
  await db.prepare('UPDATE purchases SET total_cents = ?2 WHERE id = ?1').bind(id, total).run();
  const purchase = (await getPurchase(db, id))!;
  return { purchase, tickets, items };
}

export async function setPurchaseCheckout(db: D1Database, id: string, sessionId: string, url: string): Promise<void> {
  await db.prepare('UPDATE purchases SET stripe_session_id = ?2, checkout_url = ?3 WHERE id = ?1').bind(id, sessionId, url).run();
  await db.prepare('UPDATE tickets SET stripe_session_id = ?2, checkout_url = ?3 WHERE purchase_id = ?1').bind(id, sessionId, url).run();
}

// Stripe said the money is there: the purchase and every ticket in it
// are paid (the buyer's own ticket also becomes their signup).
export async function markPurchasePaid(db: D1Database, id: string, paymentIntent: string | null, now: number): Promise<PurchaseRow | null> {
  const purchase = await getPurchase(db, id);
  if (!purchase) return null;
  if (purchase.status !== 'paid') {
    await db
      .prepare(
        `UPDATE purchases SET status = 'paid', paid_at = ?2, stripe_payment_intent = COALESCE(?3, stripe_payment_intent) WHERE id = ?1`,
      )
      .bind(id, now, paymentIntent)
      .run();
  }
  for (const ticket of await listTicketsByPurchase(db, id)) {
    await markTicketPaid(db, ticket.id, paymentIntent, null, now);
  }
  return getPurchase(db, id);
}

// Walked away, released, or Stripe's page expired: only a pending
// purchase can be voided. True when this call did it.
export async function voidPurchase(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("UPDATE purchases SET status = 'void' WHERE id = ?1 AND status = 'pending'").bind(id).run();
  for (const ticket of await listTicketsByPurchase(db, id)) await voidTicket(db, ticket.id);
  return (result.meta.changes ?? 0) > 0;
}

// A full refund in Stripe: every ticket is dead, every item is off.
export async function refundPurchase(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE purchases SET status = 'refunded' WHERE id = ?1 AND status = 'paid'").bind(id).run();
  for (const ticket of await listTicketsByPurchase(db, id)) await refundTicket(db, ticket.id);
}

// A pending purchase whose Checkout page is still open.
export function resumablePurchase(purchase: PurchaseRow | null, now: number): string | null {
  if (!purchase || purchase.status !== 'pending' || !purchase.checkout_url) return null;
  return purchase.created_at > now - PENDING_TICKET_SECONDS ? purchase.checkout_url : null;
}

// The signed-in person's open purchase, if any: it holds seats and stock,
// so the checkout offers to continue or release it before a new one.
export async function pendingPurchaseFor(db: D1Database, discordId: string, now: number): Promise<PurchaseRow | null> {
  return db
    .prepare(`SELECT * FROM purchases WHERE discord_id = ?1 AND status = 'pending' AND created_at > ?2 ORDER BY created_at DESC`)
    .bind(discordId, now - PENDING_TICKET_SECONDS)
    .first<PurchaseRow>();
}

// --- shop items after payment --------------------------------------------------------

export interface ItemWithBuyer extends PurchaseItemRow {
  buyer_name: string;
  discord_id: string | null;
  paid_at: number | null;
  purchase_status: PurchaseRow['status'];
}

const ITEM_SELECT = `SELECT i.*, u.buyer_name, u.discord_id, u.paid_at, u.status AS purchase_status
  FROM purchase_items i JOIN purchases u ON u.id = i.purchase_id`;

// What this person has paid for and not yet collected (or has collected).
export async function listMyItems(db: D1Database, discordId: string): Promise<ItemWithBuyer[]> {
  const { results } = await db
    .prepare(`${ITEM_SELECT} WHERE u.discord_id = ?1 AND u.status = 'paid' ORDER BY u.paid_at DESC, i.id`)
    .bind(discordId)
    .all<ItemWithBuyer>();
  return results;
}

// For the board: paid items waiting to be handed over, oldest first.
export async function listUndeliveredItems(db: D1Database): Promise<ItemWithBuyer[]> {
  const { results } = await db
    .prepare(`${ITEM_SELECT} WHERE u.status = 'paid' AND i.delivered_at IS NULL ORDER BY u.paid_at, i.id`)
    .all<ItemWithBuyer>();
  return results;
}

export async function listDeliveredItems(db: D1Database, limit = 50): Promise<ItemWithBuyer[]> {
  const { results } = await db
    .prepare(`${ITEM_SELECT} WHERE i.delivered_at IS NOT NULL ORDER BY i.delivered_at DESC LIMIT ?1`)
    .bind(limit)
    .all<ItemWithBuyer>();
  return results;
}

export async function markItemDelivered(db: D1Database, itemId: number, by: string, now: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE purchase_items SET delivered_at = ?2, delivered_by = ?3 WHERE id = ?1 AND delivered_at IS NULL')
    .bind(itemId, now, by)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function undoItemDelivered(db: D1Database, itemId: number): Promise<boolean> {
  const result = await db.prepare('UPDATE purchase_items SET delivered_at = NULL, delivered_by = NULL WHERE id = ?1').bind(itemId).run();
  return (result.meta.changes ?? 0) > 0;
}

// A signed-in person's purchases, newest first, for their tickets page.
export async function listMyPurchases(db: D1Database, discordId: string): Promise<PurchaseRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM purchases WHERE discord_id = ?1 AND status IN ('pending', 'paid') ORDER BY created_at DESC`)
    .bind(discordId)
    .all<PurchaseRow>();
  return results;
}
