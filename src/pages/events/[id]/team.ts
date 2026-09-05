import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import {
  createEventTeam,
  joinEventTeam,
  leaveEventTeam,
  upsertMember,
  listEventQuestions,
  getAnswers,
  RuleError,
} from '../../../lib/db';
import { answersComplete } from '../../../lib/questions';

// Tournament team actions: any signed-in member, no admin needed — forming
// teams is the members' own business.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const session = await currentSession(request, env);
  if (!session) return redirect(`${back}?err=signin`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const action = String(form.get('action') ?? '');
  const now = Math.floor(Date.now() / 1000);

  await upsertMember(
    env.DB,
    { discord_id: session.discordId, username: session.username, avatar_hash: session.avatarHash },
    now,
  );

  try {
    // Joining or founding a team needs the required questions answered
    // (the "Your details" form on the event page saves them).
    if (action === 'create' || action === 'join') {
      const questions = await listEventQuestions(env.DB, id);
      if (!answersComplete(questions, await getAnswers(env.DB, id, { discordId: session.discordId }))) {
        return redirect(`${back}?err=answers#details`, 303);
      }
    }
    if (action === 'create') {
      await createEventTeam(env.DB, id, String(form.get('name') ?? ''), session.discordId, now);
    } else if (action === 'join') {
      const teamId = Number(form.get('event_team_id'));
      if (!Number.isInteger(teamId)) return redirect(`${back}?err=missing`, 303);
      await joinEventTeam(env.DB, id, teamId, session.discordId, now);
    } else if (action === 'leave') {
      await leaveEventTeam(env.DB, id, session.discordId);
    } else {
      return redirect(`${back}?err=csrf`, 303);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
