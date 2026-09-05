import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { checkInTicket, getTicketByCode, RuleError } from '../../../lib/db';
import { normalizeTicketCode } from '../../../lib/qr';

// The holder marks their own ticket as used, at the door, in front of the
// board member: the same one-off as a scan, for events nobody scans at.
// The ticket page shows the mark of the day beside the button, so the
// board can see the page is live.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const code = normalizeTicketCode(params.code ?? '');
  const back = `/tickets/${code}`;
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const ticket = code ? await getTicketByCode(env.DB, code) : null;
  if (!ticket) return redirect('/tickets', 303);
  if (ticket.discord_id) {
    const session = await currentSession(request, env);
    if (!session || session.discordId !== ticket.discord_id) return redirect(`${back}?err=forbidden`, 303);
  }
  try {
    await checkInTicket(env.DB, ticket.code, 'holder', Math.floor(Date.now() / 1000));
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(`${back}?ok=used`, 303);
};
