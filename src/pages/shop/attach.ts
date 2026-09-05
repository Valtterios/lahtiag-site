import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { requireBoard } from '../../lib/board';
import { RuleError } from '../../lib/db';
import { attachDoorPaymentToItem } from '../../lib/purchases';

// Board: a Tap to Pay payment becomes a shop item sold and handed over.

export const POST: APIRoute = async ({ request, redirect }) => {
  const back = '/shop/orders';
  const board = await requireBoard(request, env);
  const admin = board.ok ? null : await requireAdmin(request, env);
  if (!board.ok && !admin?.ok) return redirect(`${back}?err=forbidden`, 303);
  const by = board.ok ? board.email : admin!.ok ? admin!.session.discordId : '';
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const paymentIntent = String(form.get('payment_intent') ?? '').trim();
  const productId = Number(form.get('product_id'));
  const quantity = Math.max(1, Number(form.get('quantity')) || 1);
  const holder = String(form.get('holder_name') ?? '').trim();
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent) || !Number.isInteger(productId) || !holder) return redirect(`${back}?err=bad_input`, 303);
  try {
    const purchase = await attachDoorPaymentToItem(env.DB, paymentIntent, productId, quantity, holder, by, Math.floor(Date.now() / 1000));
    return redirect(`${back}?ok=attached_item&who=${encodeURIComponent(purchase.buyer_name)}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
