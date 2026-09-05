import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  getTicketBySession,
  getTicketByPaymentIntent,
  markTicketPaid,
  voidTicket,
  refundTicket,
  recordDoorPayment,
} from '../../lib/db';
import { verifyWebhookSignature, holderNameFromSession, metadataInt, type StripeEvent } from '../../lib/stripe';

// Stripe tells us what happened with the money. Everything here is
// idempotent, because Stripe retries until it sees a 2xx.
//   checkout.session.completed  -> the ticket is paid (and the signup exists)
//   checkout.session.expired    -> the pending ticket is void, the seat is free
//   charge.refunded             -> the ticket is refunded, the signup removed
//   payment_intent.succeeded    -> a Tap to Pay payment with no ticket behind it
//                                  waits at the door to be attached (online
//                                  payments carry our metadata and are skipped)

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

  switch (event.type) {
    case 'checkout.session.completed': {
      const ticketId = metadataInt(object.metadata, 'ticket_id') ?? Number(object.client_reference_id);
      const ticket = Number.isInteger(ticketId) && ticketId > 0
        ? await env.DB.prepare('SELECT id FROM tickets WHERE id = ?1').bind(ticketId).first<{ id: number }>()
        : await getTicketBySession(env.DB, object.id);
      if (ticket) {
        await markTicketPaid(env.DB, ticket.id, object.payment_intent ?? null, holderNameFromSession(object), now);
      }
      break;
    }
    case 'checkout.session.expired': {
      const ticket = await getTicketBySession(env.DB, object.id);
      if (ticket) await voidTicket(env.DB, ticket.id);
      break;
    }
    case 'charge.refunded': {
      if (object.payment_intent && object.refunded) {
        const ticket = await getTicketByPaymentIntent(env.DB, object.payment_intent);
        if (ticket) await refundTicket(env.DB, ticket.id);
      }
      break;
    }
    case 'payment_intent.succeeded': {
      // Our own Checkout payments carry ticket metadata; a bare payment is
      // the Dashboard app's Tap to Pay, waiting for the door to say who it was.
      if (!object.metadata?.ticket_id && typeof object.amount === 'number') {
        const known = await getTicketByPaymentIntent(env.DB, object.id);
        if (!known) await recordDoorPayment(env.DB, object.id, object.amount, now);
      }
      break;
    }
    default:
      break;
  }
  return new Response('ok', { status: 200 });
};
