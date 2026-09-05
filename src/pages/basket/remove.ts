import type { APIRoute } from 'astro';
import { checkCsrf } from '../../lib/guard';
import { readBasket, writeBasket, withLine } from '../../lib/basket';

// Take a line out of the basket (or one piece of it, with count=1).

export const POST: APIRoute = async ({ request, redirect, cookies }) => {
  const form = await request.formData();
  const wanted = String(form.get('next') ?? '');
  const next = /^\/(?!\/)/.test(wanted) ? wanted : '/checkout';
  const join = next.includes('?') ? '&' : '?';
  if (!(await checkCsrf(request, form))) return redirect(`${next}${join}err=csrf`, 303);
  const kind = form.get('kind') === 'item' ? 'item' : 'ticket';
  const id = Number(form.get('id'));
  if (!Number.isInteger(id) || id <= 0) return redirect(next, 303);
  const count = Number(form.get('count'));
  const lines = readBasket(cookies);
  writeBasket(cookies, Number.isInteger(count) && count > 0 ? withLine(lines, { kind, id, count: -count }) : withLine(lines, { kind, id, count: 0 }, true));
  return redirect(next, 303);
};
