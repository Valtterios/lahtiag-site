import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../lib/guard';
import { setLeaderboardOptIn } from '../../lib/db';

// Hide from, or return to, the public leaderboard (everyone is on it by default).

export const POST: APIRoute = async ({ request, redirect }) => {
  const session = await currentSession(request, env);
  if (!session) return redirect('/membership?err=signin', 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/membership?err=csrf', 303);
  // The box is "hide me": ticked means off the board.
  await setLeaderboardOptIn(env.DB, session.discordId, form.get('hide') !== 'on');
  return redirect('/membership?ok=leaderboard#my-stats', 303);
};
