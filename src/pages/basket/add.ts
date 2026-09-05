import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../lib/guard';
import { getTicketType } from '../../lib/db';
import { readBasket, writeBasket, withLine } from '../../lib/basket';
import { getProduct, MAX_PER_PURCHASE, MAX_ITEM_QUANTITY } from '../../lib/purchases';

// "Add to basket" from an event page or the shop. Only existence is
// checked here; the checkout prices and limits every line afresh.

export const POST: APIRoute = async ({ request, redirect, cookies }) => {
  const form = await request.formData();
  const wanted = String(form.get('next') ?? '');
  const next = /^\/(?!\/)/.test(wanted) ? wanted : '/checkout';
  const join = next.includes('?') ? '&' : '?';
  if (!(await checkCsrf(request, form))) return redirect(`${next}${join}err=csrf`, 303);
  const kind = form.get('kind') === 'item' ? 'item' : 'ticket';
  const id = Number(form.get('id'));
  const count = Math.max(1, Math.min(Number(form.get('count')) || 1, kind === 'ticket' ? MAX_PER_PURCHASE : MAX_ITEM_QUANTITY));
  if (!Number.isInteger(id) || id <= 0) return redirect(`${next}${join}err=bad_input`, 303);
  const now = Math.floor(Date.now() / 1000);
  const exists = kind === 'ticket' ? await getTicketType(env.DB, id) : await getProduct(env.DB, id, now);
  if (!exists || exists.active !== 1) return redirect(`${next}${join}err=missing`, 303);
  writeBasket(cookies, withLine(readBasket(cookies), { kind, id, count }, form.get('set') === '1'));
  return redirect(form.get('checkout') === '1' ? '/checkout' : `${next}${join}ok=added`, 303);
};
