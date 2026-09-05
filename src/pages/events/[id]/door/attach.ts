import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../../lib/guard';
import { requireBoard } from '../../../../lib/board';
import { attachDoorPayment, checkInTicket, RuleError } from '../../../../lib/db';

// A Tap to Pay payment becomes a paid, checked-in door ticket for the
// named person.

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
  const typeId = Number(form.get('ticket_type_id'));
  const holder = String(form.get('holder_name') ?? '').trim();
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent) || !Number.isInteger(typeId) || !holder) {
    return redirect(`${back}?err=bad_input`, 303);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    const ticket = await attachDoorPayment(env.DB, paymentIntent, id, typeId, holder, now);
    await checkInTicket(env.DB, ticket.code, who, now);
    return redirect(`${back}?ok=attached&who=${encodeURIComponent(ticket.holder_name)}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
