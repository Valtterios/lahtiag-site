import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { requireBoard } from '../../lib/board';
import { markItemDelivered, undoItemDelivered } from '../../lib/purchases';

// Board: a shop item was handed over (or that was a mistake).

export const POST: APIRoute = async ({ request, redirect }) => {
  const back = '/shop/orders';
  const board = await requireBoard(request, env);
  const admin = board.ok ? null : await requireAdmin(request, env);
  if (!board.ok && !admin?.ok) return redirect(`${back}?err=forbidden`, 303);
  const by = board.ok ? board.email : admin!.ok ? admin!.session.discordId : '';
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect(`${back}?err=missing`, 303);
  const now = Math.floor(Date.now() / 1000);
  const ok = form.get('undo') === '1' ? await undoItemDelivered(env.DB, id) : await markItemDelivered(env.DB, id, by, now);
  if (!ok) return redirect(`${back}?err=missing`, 303);
  return redirect(`${back}?ok=${form.get('undo') === '1' ? 'undone' : 'delivered'}`, 303);
};
