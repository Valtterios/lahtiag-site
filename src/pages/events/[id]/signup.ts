import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { removeSignup, setSignup, upsertMember, listEventQuestions, saveAnswers, RuleError } from '../../../lib/db';
import { parseAnswers } from '../../../lib/questions';

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const session = await currentSession(request, env);
  if (!session) return redirect(`${back}?err=signin`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const status = String(form.get('status') ?? '');
  const now = Math.floor(Date.now() / 1000);

  // Keep the display cache fresh on every touch, same as login does.
  await upsertMember(
    env.DB,
    { discord_id: session.discordId, username: session.username, avatar_hash: session.avatarHash },
    now,
  );

  try {
    if (status === 'remove') {
      await removeSignup(env.DB, id, session.discordId);
    } else if (status === 'yes' || status === 'maybe') {
      const questions = await listEventQuestions(env.DB, id);
      if (questions.length > 0) {
        const parsed = parseAnswers(questions, form);
        if (!parsed.ok) return redirect(`${back}?err=answers#signup`, 303);
        await saveAnswers(env.DB, id, { discordId: session.discordId }, parsed.answers, now);
      }
      await setSignup(env.DB, id, session.discordId, status, now);
    } else {
      return redirect(`${back}?err=csrf`, 303);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
