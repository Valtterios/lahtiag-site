import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../lib/guard';
import { setLeaderboardOptIn } from '../../lib/db';

// Opt in to, or out of, the public leaderboard.

export const POST: APIRoute = async ({ request, redirect }) => {
  const session = await currentSession(request, env);
  if (!session) return redirect('/membership?err=signin', 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/membership?err=csrf', 303);
  await setLeaderboardOptIn(env.DB, session.discordId, form.get('leaderboard') === 'on');
  return redirect('/membership?ok=leaderboard#my-stats', 303);
};
