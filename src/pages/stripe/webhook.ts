import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { listTicketsBySession, listTicketsByPaymentIntent, getTicketByPaymentIntent, markTicketPaid, voidTicket, refundTicket, recordDoorPayment } from '../../lib/db';
import { getPurchaseBySession, getPurchaseByPaymentIntent, getPurchase, markPurchasePaid, voidPurchase, refundPurchase } from '../../lib/purchases';
import { verifyWebhookSignature, metadataInt, type StripeEvent } from '../../lib/stripe';

// Stripe tells us what happened with the money. Everything here is
// idempotent, because Stripe retries until it sees a 2xx.
//   checkout.session.completed  -> the purchase and every ticket in it are
//                                  paid (the buyer's own ticket is their
//                                  signup), unless the session is still
//                                  unpaid: a delayed-notification method, then
//   checkout.session.async_payment_succeeded / _failed decide it
//   checkout.session.expired    -> the pending purchase is void, seats and
//                                  stock are free
//   charge.refunded             -> a full refund: the purchase and its tickets
//                                  are refunded, the buyer's signup removed
//   payment_intent.succeeded    -> a Tap to Pay payment with no purchase behind
//                                  it waits at the door to be attached (online
//                                  payments carry our metadata and are skipped)
// Tickets sold before purchases existed have a session id but no
// purchase; they are handled one by one.

export const POST: APIRoute = async ({ request }) => {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('not configured', { status: 503 });
  const payload = await request.text();
  const ok = await verifyWebhookSignature(env.STRIPE_WEBHOOK_SECRET, payload, request.headers.get('stripe-signature'));
  if (!ok) return new Response('bad signature', { status: 400 });

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const object = event.data.object;

  // The purchase behind a Checkout Session: by session id, or by the id in
  // our metadata (a purchase whose checkout url was never stored).
  const sessionPurchase = async () => {
    const bySession = await getPurchaseBySession(env.DB, object.id);
    if (bySession) return bySession;
    const id = String(object.metadata?.purchase_id ?? object.client_reference_id ?? '');
    return /^[A-Z0-9]{10}$/.test(id) ? await getPurchase(env.DB, id) : null;
  };
  const legacyTickets = async (): Promise<{ id: number }[]> => {
    const bySession = await listTicketsBySession(env.DB, object.id);
    if (bySession.length > 0) return bySession;
    const single = metadataInt(object.metadata, 'ticket_id');
    return single ? [{ id: single }] : [];
  };

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // Fulfil only once the money is there; an unpaid completed session
      // waits for its async_payment event.
      if (object.payment_status === 'unpaid') break;
      const purchase = await sessionPurchase();
      if (purchase) {
        await markPurchasePaid(env.DB, purchase.id, object.payment_intent ?? null, now);
      } else {
        for (const ticket of await legacyTickets()) await markTicketPaid(env.DB, ticket.id, object.payment_intent ?? null, null, now);
      }
      break;
    }
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const purchase = await sessionPurchase();
      if (purchase) await voidPurchase(env.DB, purchase.id);
      else for (const ticket of await legacyTickets()) await voidTicket(env.DB, ticket.id);
      break;
    }
    case 'charge.refunded': {
      // Only a full refund kills the purchase; a partial one is the board's
      // goodwill and leaves it valid.
      if (!object.refunded) break;
      const purchase = object.payment_intent ? await getPurchaseByPaymentIntent(env.DB, object.payment_intent) : null;
      if (purchase) {
        await refundPurchase(env.DB, purchase.id);
        break;
      }
      const tickets: { id: number }[] = object.payment_intent ? await listTicketsByPaymentIntent(env.DB, object.payment_intent) : [];
      const byMeta = metadataInt(object.metadata, 'ticket_id');
      if (tickets.length === 0 && byMeta) tickets.push({ id: byMeta });
      for (const ticket of tickets) await refundTicket(env.DB, ticket.id);
      break;
    }
    case 'payment_intent.succeeded': {
      // Our own Checkout payments carry our metadata; a bare payment is the
      // Dashboard app's Tap to Pay, waiting for the door to say who it was.
      if (!object.metadata?.purchase_id && !object.metadata?.ticket_id && typeof object.amount === 'number') {
        const known = (await getTicketByPaymentIntent(env.DB, object.id)) ?? (await getPurchaseByPaymentIntent(env.DB, object.id));
        if (!known) await recordDoorPayment(env.DB, object.id, object.amount, now);
      }
      break;
    }
    default:
      break;
  }
  return new Response('ok', { status: 200 });
};
