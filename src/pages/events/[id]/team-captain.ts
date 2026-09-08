import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { captainAddToTeam, captainRemoveFromTeam, captainSetTeamPlace, RuleError } from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';
import { later, notifyTeamPlacement } from '../../../lib/event-channel';

// A team's founder adds a loose player to it, takes a member out, or
// swaps one between the starting line-up and the bench.

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const session = await currentSession(request, env);
  if (!session) return redirect(`${back}?err=signin`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const teamId = Number(form.get('event_team_id'));
  const target = String(form.get('discord_id') ?? '').trim();
  if (!Number.isInteger(teamId) || !target) return redirect(`${back}?err=bad_input`, 303);
  const now = Math.floor(Date.now() / 1000);
  const action = String(form.get('action') ?? '');
  try {
    if (action === 'kick') await captainRemoveFromTeam(env.DB, id, teamId, session.discordId, target, now);
    else if (action === 'place') await captainSetTeamPlace(env.DB, id, teamId, session.discordId, target, form.get('reserve') === '1', now);
    else await captainAddToTeam(env.DB, id, teamId, session.discordId, target, now);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}${action === 'place' ? '#teams' : ''}`, 303);
    throw error;
  }
  if (action === 'place') return redirect(`${back}?ok=placed#teams`, 303);
  syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
  if (action !== 'kick') later(locals.cfContext, notifyTeamPlacement(env.DB, env, id, [{ discordId: target, teamId }], url.origin));
  return redirect(`${back}?ok=${action === 'kick' ? 'team_kicked' : 'team_added'}`, 303);
};
