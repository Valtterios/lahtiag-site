import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession, requireAdmin } from '../../../lib/guard';
import { joinWaitlist, leaveWaitlist, upsertMember, RuleError } from '../../../lib/db';

// Join or leave the waitlist of a full event. The board can take anyone
// off it with a discord_id.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const session = await currentSession(request, env);
  if (!session) return redirect(`${back}?err=signin`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const now = Math.floor(Date.now() / 1000);
  const action = String(form.get('action') ?? '');
  const target = String(form.get('discord_id') ?? '').trim();
  try {
    if (action === 'join') {
      await upsertMember(env.DB, { discord_id: session.discordId, username: session.username, avatar_hash: session.avatarHash }, now);
      await joinWaitlist(env.DB, id, session.discordId, now);
      return redirect(`${back}?ok=waitlisted#signup`, 303);
    }
    if (action === 'leave') {
      if (target && target !== session.discordId) {
        const admin = await requireAdmin(request, env);
        if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
      }
      await leaveWaitlist(env.DB, id, target || session.discordId);
      return redirect(`${back}?ok=left_waitlist#signup`, 303);
    }
    return redirect(`${back}?err=csrf`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}#signup`, 303);
    throw error;
  }
};
