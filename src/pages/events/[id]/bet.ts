import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { RuleError, mainBracket, getBracket } from '../../../lib/db';
import { placeBet, cancelBet, ownKey, bracketKeys } from '../../../lib/coins';

// A stake on the event's bracket from the event page (src/lib/coins.ts),
// or taking it back while betting is open.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = (q: string) => redirect(`/events/${id}?${q}#betting`, 303);
  const session = await currentSession(request, env);
  if (!session) return back('err=signin');
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return back('err=csrf');
  const now = Math.floor(Date.now() / 1000);
  try {
    if (String(form.get('action')) === 'cancel') {
      await cancelBet(env.DB, id, session.discordId, now);
      return back('ok=bet_back');
    }
    const main = await mainBracket(env.DB, id);
    const keys = main ? bracketKeys(await getBracket(env.DB, main.id)) : [];
    await placeBet(env.DB, id, session.discordId, String(form.get('pick') ?? ''), Number(form.get('coins')), keys, await ownKey(env.DB, id, session.discordId), now);
    return back('ok=bet_on');
  } catch (error) {
    if (error instanceof RuleError) return back(`err=${error.code === 'bad_input' ? 'bet_input' : error.code}`);
    throw error;
  }
};
