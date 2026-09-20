import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { addManualParticipant, addMemberParticipant, addDiscordParticipant, RuleError } from '../../../lib/db';
import { fetchGuildMemberInfo } from '../../../lib/discord';
import { DISCORD_GUILD_ID } from '../../../lib/config';
import { syncTeamDiscordInBackground, syncEventRolesInBackground } from '../../../lib/event-discord';
import { refreshAnnouncementInBackground } from '../../../lib/announce';

// Three ways onto a roster by hand. A member is added against their own
// Discord account, so the event's role, their ticks and their stats all
// follow; any other Discord account from the server goes on the same way
// (the friend who turned up with a team and never signed up); a walk-in
// is a name and nothing else, which is right for a stranger at the door
// and wrong for anybody with a Discord account.

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}#participants`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf#participants`, 303);

  const status = String(form.get('status') ?? '');
  if (status !== 'yes' && status !== 'maybe') return redirect(`${back}?err=bad_input#participants`, 303);
  const teamRaw = String(form.get('event_team_id') ?? '').trim();
  const teamId = teamRaw === '' ? null : Number(teamRaw);
  if (teamId !== null && !Number.isInteger(teamId)) return redirect(`${back}?err=bad_input#participants`, 303);
  const registerRaw = String(form.get('register_id') ?? '').trim();
  const discordRaw = String(form.get('discord_id') ?? '').trim();
  const now = Math.floor(Date.now() / 1000);
  let ok = 'added';

  try {
    if (registerRaw !== '') {
      const registerId = Number(registerRaw);
      if (!Number.isInteger(registerId)) return redirect(`${back}?err=bad_input#participants`, 303);
      await addMemberParticipant(env.DB, id, registerId, status, teamId, now);
      ok = 'member_added';
    } else if (discordRaw !== '') {
      // The picker sends an id and nothing else, and an id typed by hand
      // may be a mistake, so the name comes from the server itself.
      const info = env.DISCORD_BOT_TOKEN
        ? await fetchGuildMemberInfo(env.DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, discordRaw)
        : null;
      if (env.DISCORD_BOT_TOKEN && !info) return redirect(`${back}?err=not_in_server#participants`, 303);
      await addDiscordParticipant(env.DB, id, discordRaw, info?.display ?? '', status, teamId, now);
      ok = 'guest_added';
    } else {
      await addManualParticipant(env.DB, id, String(form.get('name') ?? ''), status, teamId, now);
    }
    if (ok !== 'added') {
      // A real account, so the event's role and the announcement's count
      // both have something to follow.
      syncEventRolesInBackground(locals.cfContext, env.DB, env, [id], now);
      refreshAnnouncementInBackground(locals.cfContext, env.DB, env, [id], url.origin);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}#participants`, 303);
    throw error;
  }
  syncTeamDiscordInBackground(locals.cfContext, env.DB, env, id, now);
  return redirect(`${back}?ok=${ok}#participants`, 303);
};
