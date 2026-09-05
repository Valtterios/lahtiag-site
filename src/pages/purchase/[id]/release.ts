import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { getPurchase, voidPurchase } from '../../../lib/purchases';
import { expireCheckoutSession } from '../../../lib/stripe';

// "Release": a pending purchase the buyer does not want to finish (wrong
// ticket, changed their mind). Stripe's page is expired first so it
// cannot be paid later, then the purchase and its tickets are void and
// the seats and stock are free again. Holding the id is holding the
// purchase; one on a Discord account also needs that account signed in.

const PENDING_COOKIE = '__Host-pending-purchase';

export const POST: APIRoute = async ({ request, params, redirect, cookies }) => {
  const id = (params.id ?? '').toUpperCase();
  const form = await request.formData();
  const wanted = String(form.get('next') ?? '');
  const next = /^\/(?!\/)/.test(wanted) ? wanted : '/checkout';
  const join = next.includes('?') ? '&' : '?';
  if (!(await checkCsrf(request, form))) return redirect(`${next}${join}err=csrf`, 303);
  const purchase = /^[A-Z0-9]{10}$/.test(id) ? await getPurchase(env.DB, id) : null;
  if (!purchase) return redirect(next, 303);
  if (purchase.status !== 'pending') return redirect(`/purchase/${purchase.id}`, 303);
  if (purchase.discord_id) {
    const session = await currentSession(request, env);
    if (!session || session.discordId !== purchase.discord_id) return redirect(`${next}${join}err=forbidden`, 303);
  }
  if (purchase.stripe_session_id && env.STRIPE_SECRET_KEY) {
    const state = await expireCheckoutSession(env.STRIPE_SECRET_KEY, purchase.stripe_session_id);
    // Paid in the meantime: nothing to release, the webhook marks it.
    if (state === 'paid') return redirect(`/purchase/${purchase.id}?paid=1`, 303);
  }
  await voidPurchase(env.DB, purchase.id);
  cookies.delete(PENDING_COOKIE, { path: '/' });
  return redirect(`${next}${join}ok=released`, 303);
};
