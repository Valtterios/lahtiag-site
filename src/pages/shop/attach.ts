import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { requireBoard } from '../../lib/board';
import { RuleError } from '../../lib/db';
import { attachDoorPayment } from '../../lib/purchases';
import { doorLines, attachSummary } from '../../lib/door';

// Board: a Tap to Pay payment becomes shop items sold and handed over —
// several different ones in the same payment if that is what was bought.
// Tickets belong to an event, so they are attached on its door page.

export const POST: APIRoute = async ({ request, redirect }) => {
  const back = '/shop/orders';
  const board = await requireBoard(request, env);
  const admin = board.ok ? null : await requireAdmin(request, env);
  if (!board.ok && !admin?.ok) return redirect(`${back}?err=forbidden`, 303);
  const by = board.ok ? board.email : admin!.ok ? admin!.session.discordId : '';
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const paymentIntent = String(form.get('payment_intent') ?? '').trim();
  const holder = String(form.get('holder_name') ?? '').trim();
  const lines = doorLines(form, holder, true);
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent) || !holder || lines.length === 0) return redirect(`${back}?err=bad_input`, 303);
  try {
    const made = await attachDoorPayment(env.DB, paymentIntent, { eventId: null, lines, buyerName: holder, by }, Math.floor(Date.now() / 1000));
    return redirect(`${back}?ok=attached_item&who=${encodeURIComponent(attachSummary(made))}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
