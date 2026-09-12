import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../../lib/guard';
import { RuleError, mainBracket, getBracket } from '../../../lib/db';
import { placeBet, cancelBet, ownKey, bracketKeys, nextMatchOf, WINNER } from '../../../lib/coins';

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
    const main = await mainBracket(env.DB, id);
    const matches = main ? await getBracket(env.DB, main.id) : [];
    const keys = bracketKeys(matches);
    const pick = String(form.get('pick') ?? '');
    const scope = String(form.get('on') ?? 'winner') === 'match' && main ? (nextMatchOf(matches, main.id, pick)?.scope ?? null) : WINNER;
    if (String(form.get('action')) === 'cancel') {
      await cancelBet(env.DB, id, session.discordId, now, String(form.get('scope') ?? WINNER));
      return back('ok=bet_back');
    }
    if (scope === null) return back('err=no_match');
    await placeBet(env.DB, id, session.discordId, pick, Number(form.get('coins')), keys, await ownKey(env.DB, id, session.discordId), now, scope);
    return back('ok=bet_on');
  } catch (error) {
    if (error instanceof RuleError) return back(`err=${error.code === 'bad_input' ? 'bet_input' : error.code}`);
    throw error;
  }
};
