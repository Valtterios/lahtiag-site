import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../../lib/guard';
import { requireBoard } from '../../../../lib/board';
import { checkInTicket, undoCheckIn, getTicketByCode, RuleError } from '../../../../lib/db';
import { normalizeTicketCode, codeFromScan } from '../../../../lib/qr';

// Check a ticket in (or undo it). Board role or register access.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}/door`;
  const board = await requireBoard(request, env);
  const admin = board.ok ? null : await requireAdmin(request, env);
  if (!board.ok && !admin?.ok) return redirect(`${back}?err=forbidden`, 303);
  const who = board.ok ? board.email : admin!.ok ? admin!.session.discordId : '';

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const raw = String(form.get('code') ?? '');
  const code = normalizeTicketCode(raw) ?? codeFromScan(raw);
  if (!code) return redirect(`${back}?err=missing`, 303);

  try {
    if (form.get('undo') === '1') {
      const ticket = await getTicketByCode(env.DB, code);
      if (!ticket || ticket.event_id !== id) return redirect(`${back}?err=missing`, 303);
      await undoCheckIn(env.DB, ticket.id);
      return redirect(`${back}?ok=undone&who=${encodeURIComponent(ticket.holder_name)}`, 303);
    }
    const ticket = await getTicketByCode(env.DB, code);
    if (!ticket || ticket.event_id !== id) return redirect(`${back}?err=missing`, 303);
    const done = await checkInTicket(env.DB, code, who, Math.floor(Date.now() / 1000));
    return redirect(`${back}?ok=in&who=${encodeURIComponent(done.holder_name)}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
