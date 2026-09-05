import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { getEvent, listEventQuestions, saveAnswers } from '../../../lib/db';
import { parseAnswers } from '../../../lib/questions';

// A signed-in person saving or updating their own answers to an event's
// questions, on their own (team events, or editing later). Allowed while
// signups are open.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const session = await currentSession(request, env);
  if (!session) return redirect(`${back}?err=signin`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const event = Number.isInteger(id) ? await getEvent(env.DB, id) : null;
  if (!event) return redirect('/events?err=missing', 303);
  if (event.cancelled_at !== null) return redirect(`${back}?err=cancelled`, 303);
  if (event.signups_closed_at !== null) return redirect(`${back}?err=closed`, 303);

  const questions = await listEventQuestions(env.DB, id);
  const parsed = parseAnswers(questions, form);
  if (!parsed.ok) return redirect(`${back}?err=answers#details`, 303);
  await saveAnswers(env.DB, id, { discordId: session.discordId }, parsed.answers, Math.floor(Date.now() / 1000));
  return redirect(`${back}?ok=answers_saved#details`, 303);
};
