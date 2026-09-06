import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { adminCreateTeam, autoTeamLoosePlayers, RuleError } from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';

// Board: make an empty team to assign people to, or group everyone
// without a team into teams of the event's size.

export const POST: APIRoute = async ({ request, params, redirect, locals }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const now = Math.floor(Date.now() / 1000);
  try {
    if (form.get('action') === 'auto') {
      await autoTeamLoosePlayers(env.DB, id, now);
      syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
      return redirect(`${back}?ok=grouped`, 303);
    }
    await adminCreateTeam(env.DB, id, String(form.get('name') ?? ''), admin.session.discordId, now);
    // A big event's team voice channels follow the teams.
    syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
    return redirect(`${back}?ok=team_saved`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
