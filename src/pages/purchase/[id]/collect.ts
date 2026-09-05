import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { getPurchase, purchaseItems, markItemDelivered } from '../../../lib/purchases';

// The buyer marks a shop item as collected, in front of the board member
// handing it over. The purchase page shows the mark of the day beside the
// button, so the board can see the page is live, not a screenshot.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = (params.id ?? '').toUpperCase();
  const back = `/purchase/${id}`;
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const purchase = /^[A-Z0-9]{10}$/.test(id) ? await getPurchase(env.DB, id) : null;
  if (!purchase || purchase.status !== 'paid') return redirect(back, 303);
  if (purchase.discord_id) {
    const session = await currentSession(request, env);
    if (!session || session.discordId !== purchase.discord_id) return redirect(`${back}?err=forbidden`, 303);
  }
  const itemId = Number(form.get('item'));
  const item = (await purchaseItems(env.DB, purchase.id)).find((i) => i.id === itemId);
  if (!item) return redirect(`${back}?err=missing`, 303);
  await markItemDelivered(env.DB, item.id, 'buyer', Math.floor(Date.now() / 1000));
  return redirect(`${back}?ok=collected`, 303);
};
