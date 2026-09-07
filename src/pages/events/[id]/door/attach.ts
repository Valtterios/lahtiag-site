import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../../lib/guard';
import { requireBoard } from '../../../../lib/board';
import { checkInTicket, RuleError } from '../../../../lib/db';
import { attachDoorPayment, type DoorLine } from '../../../../lib/purchases';
import { doorLines, attachSummary } from '../../../../lib/door';

// A Tap to Pay payment becomes what it paid for: door tickets by name,
// checked in on the spot, and shop items sold and handed over. One payment
// can hold several of each, so the form posts one line per thing.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}/door`;
  const board = await requireBoard(request, env);
  const admin = board.ok ? null : await requireAdmin(request, env);
  if (!board.ok && !admin?.ok) return redirect(`${back}?err=forbidden`, 303);
  const who = board.ok ? board.email : admin!.ok ? admin!.session.discordId : '';

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const paymentIntent = String(form.get('payment_intent') ?? '').trim();
  const holder = String(form.get('holder_name') ?? '').trim();
  const lines: DoorLine[] = doorLines(form, holder);
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent) || !holder || lines.length === 0) {
    return redirect(`${back}?err=bad_input`, 303);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    const made = await attachDoorPayment(env.DB, paymentIntent, { eventId: id, lines, buyerName: holder, by: who }, now);
    for (const ticket of made.tickets) await checkInTicket(env.DB, ticket.code, who, now);
    return redirect(`${back}?ok=attached&who=${encodeURIComponent(attachSummary(made))}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
