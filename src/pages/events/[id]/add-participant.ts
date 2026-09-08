import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { addManualParticipant, addMemberParticipant, RuleError } from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground, syncEventRolesInBackground } from '../../../lib/event-discord';
import { refreshAnnouncementInBackground } from '../../../lib/announce';

// Two ways onto a roster by hand. A member is added against their own
// Discord account, so the event's role, their ticks and their stats all
// follow; a walk-in is a name and nothing else, which is right for a
// stranger at the door and wrong for anybody else.

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
  const now = Math.floor(Date.now() / 1000);

  try {
    if (registerRaw !== '') {
      const registerId = Number(registerRaw);
      if (!Number.isInteger(registerId)) return redirect(`${back}?err=bad_input#participants`, 303);
      await addMemberParticipant(env.DB, id, registerId, status, teamId, now);
      // A real account, so the event's role and the announcement's count
      // both have something to follow.
      syncEventRolesInBackground(locals.cfContext, env.DB, env, [id], now);
      refreshAnnouncementInBackground(locals.cfContext, env.DB, env, [id], url.origin);
    } else {
      await addManualParticipant(env.DB, id, String(form.get('name') ?? ''), status, teamId, now);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}#participants`, 303);
    throw error;
  }
  syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
  return redirect(`${back}?ok=${registerRaw !== '' ? 'member_added' : 'added'}#participants`, 303);
};
