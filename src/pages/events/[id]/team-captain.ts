import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { captainAddToTeam, captainRemoveFromTeam, RuleError } from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';

// A team's founder adds a loose player to it or takes a member out.

export const POST: APIRoute = async ({ request, params, redirect, locals }) => {
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
  try {
    if (form.get('action') === 'kick') await captainRemoveFromTeam(env.DB, id, teamId, session.discordId, target, now);
    else await captainAddToTeam(env.DB, id, teamId, session.discordId, target, now);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
  return redirect(`${back}?ok=${form.get('action') === 'kick' ? 'team_kicked' : 'team_added'}`, 303);
};
