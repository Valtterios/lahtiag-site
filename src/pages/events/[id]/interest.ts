import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { toggleInterest, upsertMember, RuleError } from '../../../lib/db';

// The Interested heart: on or off for the signed-in person.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const session = await currentSession(request, env);
  if (!session) return redirect(`${back}?err=signin`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const now = Math.floor(Date.now() / 1000);
  await upsertMember(env.DB, { discord_id: session.discordId, username: session.username, avatar_hash: session.avatarHash }, now);
  try {
    const on = await toggleInterest(env.DB, id, session.discordId, now);
    return redirect(`${back}?ok=${on ? 'interested' : 'uninterested'}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
