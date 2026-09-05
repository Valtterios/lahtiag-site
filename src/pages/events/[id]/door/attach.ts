import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../../lib/guard';
import { requireBoard } from '../../../../lib/board';
import { attachDoorPayment, checkInTicket, RuleError } from '../../../../lib/db';
import { attachDoorPaymentToItem } from '../../../../lib/purchases';

// A Tap to Pay payment becomes a paid, checked-in door ticket for the
// named person, or a shop item sold and handed over on the spot.

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
  const what = String(form.get('what') ?? `ticket:${String(form.get('ticket_type_id') ?? '')}`);
  const [kind, idText] = what.split(':');
  const targetId = Number(idText);
  const holder = String(form.get('holder_name') ?? '').trim();
  const quantity = Math.max(1, Number(form.get('quantity')) || 1);
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent) || !Number.isInteger(targetId) || !holder) {
    return redirect(`${back}?err=bad_input`, 303);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    if (kind === 'item') {
      const purchase = await attachDoorPaymentToItem(env.DB, paymentIntent, targetId, quantity, holder, who, now);
      return redirect(`${back}?ok=attached_item&who=${encodeURIComponent(purchase.buyer_name)}`, 303);
    }
    const ticket = await attachDoorPayment(env.DB, paymentIntent, id, targetId, holder, now);
    await checkInTicket(env.DB, ticket.code, who, now);
    return redirect(`${back}?ok=attached&who=${encodeURIComponent(ticket.holder_name)}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
