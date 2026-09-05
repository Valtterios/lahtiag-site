import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { getEvent, getTicketType, ticketOffer, createTicket, voidTicket, upsertMember, getRegisterByDiscord, RuleError } from '../../../lib/db';
import { createCheckoutSession, stripeConfigured } from '../../../lib/stripe';
import { formatHelsinkiRange } from '../../../lib/time';

// Buying a ticket from the event page, signed in. A free ticket is issued
// on the spot; a paid one becomes a pending ticket (holding the seat for
// the checkout window) and the person is sent to Stripe's hosted page.
// The webhook turns pending into paid, or void if they walked away.

export const POST: APIRoute = async ({ request, params, redirect, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const session = await currentSession(request, env);
  if (!session) return redirect(`${back}?err=signin`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const typeId = Number(form.get('ticket_type_id'));
  if (!Number.isInteger(id) || !Number.isInteger(typeId)) return redirect(`${back}?err=bad_input`, 303);

  const now = Math.floor(Date.now() / 1000);
  await upsertMember(env.DB, { discord_id: session.discordId, username: session.username, avatar_hash: session.avatarHash }, now);

  const event = await getEvent(env.DB, id);
  const type = await getTicketType(env.DB, typeId);
  if (!event || !type || type.event_id !== id) return redirect(`${back}?err=missing`, 303);

  const offer = await ticketOffer(env.DB, event, type, session.discordId, now);
  if (!offer.ok) return redirect(`${back}?err=${offer.reason}`, 303);

  const holder = session.username;
  try {
    if (offer.amount_cents === 0) {
      const ticket = await createTicket(
        env.DB,
        { event_id: id, ticket_type_id: typeId, discord_id: session.discordId, holder_name: holder, amount_cents: 0, status: 'paid', source: 'online' },
        now,
      );
      return redirect(`/tickets/${ticket.code}?ok=issued`, 303);
    }
    if (!stripeConfigured(env)) return redirect(`${back}?err=payments_off`, 303);

    const ticket = await createTicket(
      env.DB,
      { event_id: id, ticket_type_id: typeId, discord_id: session.discordId, holder_name: holder, amount_cents: offer.amount_cents, status: 'pending', source: 'online' },
      now,
    );
    const entry = await getRegisterByDiscord(env.DB, session.discordId);
    const checkout = await createCheckoutSession(env.STRIPE_SECRET_KEY!, {
      amountCents: offer.amount_cents,
      productName: `${event.title}: ${type.name}`,
      description: formatHelsinkiRange(event.starts_at, event.ends_at),
      successUrl: `${url.origin}/tickets/${ticket.code}?paid=1`,
      cancelUrl: `${back}?err=cancelled_checkout`,
      clientReferenceId: String(ticket.id),
      metadata: { ticket_id: String(ticket.id), event_id: String(id), discord_id: session.discordId },
      customerEmail: entry?.email,
    });
    if (!checkout) {
      await voidTicket(env.DB, ticket.id);
      return redirect(`${back}?err=stripe_down`, 303);
    }
    await env.DB.prepare('UPDATE tickets SET stripe_session_id = ?2 WHERE id = ?1').bind(ticket.id, checkout.id).run();
    return redirect(checkout.url, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
