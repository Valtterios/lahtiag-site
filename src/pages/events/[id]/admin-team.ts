import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { adminCreateTeam, autoTeamLoosePlayers, renameEventTeam, listSignups, RuleError } from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground, renameTeamVoiceChannel } from '../../../lib/event-discord';
import { later, refreshLiveBracket, notifyTeamPlacement } from '../../../lib/event-channel';
import { refreshAnnouncementInBackground } from '../../../lib/announce';

// Board: make an empty team to assign people to, or group everyone
// without a team into teams of the event's size.

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}#participants`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf#participants`, 303);
  const now = Math.floor(Date.now() / 1000);
  try {
    if (form.get('action') === 'rename') {
      const teamId = Number(form.get('team_id'));
      const name = String(form.get('name') ?? '');
      if (!Number.isInteger(teamId)) return redirect(`${back}?err=bad_input#participants`, 303);
      await renameEventTeam(env.DB, id, teamId, name);
      // The voice channel and the live bracket carry the new name.
      later(locals.cfContext, renameTeamVoiceChannel(env.DB, env, id, teamId, name));
      later(locals.cfContext, refreshLiveBracket(env.DB, env, id, url.origin, now));
      return redirect(`${back}?ok=team_renamed#participants`, 303);
    }
    if (form.get('action') === 'auto') {
      const loose = (await listSignups(env.DB, id)).filter((s) => s.status === 'yes' && s.event_team_id === null).map((s) => s.discord_id);
      await autoTeamLoosePlayers(env.DB, id, now);
      syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
      // Everyone just grouped hears which team they landed in.
      const placed = (await listSignups(env.DB, id)).filter((s) => loose.includes(s.discord_id) && s.event_team_id !== null).map((s) => ({ discordId: s.discord_id, teamId: s.event_team_id! }));
      later(locals.cfContext, notifyTeamPlacement(env.DB, env, id, placed, url.origin));
      refreshAnnouncementInBackground(locals.cfContext, env.DB, env, [id], url.origin);
      return redirect(`${back}?ok=grouped#participants`, 303);
    }
    await adminCreateTeam(env.DB, id, String(form.get('name') ?? ''), admin.session.discordId, now);
    // A big event's team voice channels follow the teams.
    syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
    refreshAnnouncementInBackground(locals.cfContext, env.DB, env, [id], url.origin);
    return redirect(`${back}?ok=team_saved#participants`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}#participants`, 303);
    throw error;
  }
};
