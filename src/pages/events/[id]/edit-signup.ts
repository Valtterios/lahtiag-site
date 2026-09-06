import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { adminUpdateSignup, RuleError } from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';
import { refreshAnnouncementInBackground } from '../../../lib/announce';
import { announcePromotionsInBackground, later, notifyTeamPlacement } from '../../../lib/event-channel';

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const status = String(form.get('status') ?? '');
  if (status !== 'yes' && status !== 'maybe') return redirect(`${back}?err=bad_input`, 303);
  const teamRaw = String(form.get('event_team_id') ?? '').trim();
  const teamId = teamRaw === '' ? null : Number(teamRaw);
  if (teamId !== null && !Number.isInteger(teamId)) return redirect(`${back}?err=bad_input`, 303);

  try {
    await adminUpdateSignup(env.DB, id, String(form.get('discord_id') ?? ''), status, teamId);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  // Moving people between teams can empty one; the voice channels follow.
  syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, Math.floor(Date.now() / 1000));
  // Put into a team by the board: they hear about it.
  if (teamId !== null) later(locals.cfContext, notifyTeamPlacement(env.DB, env, id, [{ discordId: String(form.get('discord_id') ?? ''), teamId }], url.origin));
  announcePromotionsInBackground(locals.cfContext, env.DB, env, Math.floor(Date.now() / 1000));
  refreshAnnouncementInBackground(locals.cfContext, env.DB, env, [id], url.origin);
  return redirect(back, 303);
};
