import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { getTicketByCode, voidTicket } from '../../../lib/db';
import { normalizeTicketCode } from '../../../lib/qr';
import { expireCheckoutSession } from '../../../lib/stripe';

// "Release this seat": a pending ticket whose payment the buyer does not
// want to finish (wrong ticket type, changed their mind). Stripe's page is
// expired first so it cannot be paid later, then the ticket is void and
// the seat is free to buy again. Holding the code is holding the ticket;
// one on a Discord account also needs that account signed in.

const PENDING_COOKIE = '__Host-pending-ticket';

export const POST: APIRoute = async ({ request, params, redirect, cookies }) => {
  const code = normalizeTicketCode(params.code ?? '');
  const form = await request.formData();
  const ticket = code ? await getTicketByCode(env.DB, code) : null;
  const wanted = String(form.get('next') ?? '');
  const next = /^\/(?!\/)/.test(wanted) ? wanted : ticket ? `/events/${ticket.event_id}` : '/events';
  const join = next.includes('?') ? '&' : '?';
  if (!(await checkCsrf(request, form))) return redirect(`${next}${join}err=csrf`, 303);
  if (!ticket) return redirect('/tickets', 303);
  if (ticket.status !== 'pending') return redirect(`/tickets/${ticket.code}`, 303);
  if (ticket.discord_id) {
    const session = await currentSession(request, env);
    if (!session || session.discordId !== ticket.discord_id) return redirect(`${next}${join}err=forbidden`, 303);
  }
  if (ticket.stripe_session_id && env.STRIPE_SECRET_KEY) {
    const state = await expireCheckoutSession(env.STRIPE_SECRET_KEY, ticket.stripe_session_id);
    // Paid in the meantime: nothing to release, the webhook marks it.
    if (state === 'paid') return redirect(`/tickets/${ticket.code}?paid=1`, 303);
  }
  await voidTicket(env.DB, ticket.id);
  cookies.delete(PENDING_COOKIE, { path: '/' });
  return redirect(`${next}${join}ok=released`, 303);
};
