import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { adminUpdateSignup, RuleError } from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';
import { refreshAnnouncementInBackground } from '../../../lib/announce';
import { announcePromotionsInBackground, later, notifyTeamPlacement, notifyCaptainJoin } from '../../../lib/event-channel';

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const here = `${back}#participants`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}#participants`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf#participants`, 303);

  const status = String(form.get('status') ?? '');
  if (status !== 'yes' && status !== 'maybe') return redirect(`${back}?err=bad_input#participants`, 303);
  const teamRaw = String(form.get('event_team_id') ?? '').trim();
  const teamId = teamRaw === '' ? null : Number(teamRaw);
  if (teamId !== null && !Number.isInteger(teamId)) return redirect(`${back}?err=bad_input#participants`, 303);
  // The form says which place on the team only on events that have a
  // bench; without it, they go wherever the team has room.
  const reserve = form.get('reserve_set') === '1' ? form.get('reserve') === 'on' : undefined;

  try {
    await adminUpdateSignup(env.DB, id, String(form.get('discord_id') ?? ''), status, teamId, reserve);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}#participants`, 303);
    throw error;
  }
  // Moving people between teams can empty one; the voice channels follow.
  syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, Math.floor(Date.now() / 1000));
  // Put into a team by the board: they hear about it.
  if (teamId !== null) {
    later(locals.cfContext, notifyTeamPlacement(env.DB, env, id, [{ discordId: String(form.get('discord_id') ?? ''), teamId }], url.origin));
    later(locals.cfContext, notifyCaptainJoin(env.DB, env, id, teamId, String(form.get('discord_id') ?? ''), url.origin));
  }
  announcePromotionsInBackground(locals.cfContext, env.DB, env, Math.floor(Date.now() / 1000));
  refreshAnnouncementInBackground(locals.cfContext, env.DB, env, [id], url.origin);
  return redirect(`${back}?ok=signup_saved#participants`, 303);
};
