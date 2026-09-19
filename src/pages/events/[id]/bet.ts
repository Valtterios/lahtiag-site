import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession, requireAdmin } from '../../../lib/guard';
import { RuleError, mainBracket, getBracket } from '../../../lib/db';
import { placeBet, cancelBet, closeMarket, reopenMarket, listMarkets, marketState, ownKey, bracketKeys, marketPool, nextMatchOf, WINNER } from '../../../lib/coins';

// A stake on the event's bracket from the event page (src/lib/coins.ts),
// or taking it back while betting is open. The board also locks a pool
// from here when a match is about to be played: stakes otherwise stand
// until the result is recorded, which is minutes of betting on a game
// whose outcome the room can already see.

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
    const given = String(form.get('scope') ?? '');
    const scope = given ? given : String(form.get('on') ?? 'winner') === 'match' && main ? (nextMatchOf(matches, main.id, pick)?.scope ?? null) : WINNER;
    const action = String(form.get('action') ?? '');
    // The board's locks. `lock_all` is the one for "they are starting
    // now": every match pool still open closes at once.
    if (action === 'lock' || action === 'unlock' || action === 'lock_all') {
      const admin = await requireAdmin(request, env);
      if (!admin.ok) return back(`err=${admin.reason}`);
      if (action === 'lock_all') {
        const open = (await listMarkets(env.DB, id)).filter((m) => m.scope !== WINNER && marketState(m) === 'open');
        for (const market of open) await closeMarket(env.DB, id, now, market.scope);
        return back(`ok=bets_locked&n=${open.length}`);
      }
      const which = String(form.get('scope') ?? '');
      if (!which) return back('err=bad_input');
      if (action === 'lock') await closeMarket(env.DB, id, now, which);
      else await reopenMarket(env.DB, id, which);
      return back(`ok=${action === 'lock' ? 'bets_locked&n=1' : 'bets_unlocked'}`);
    }
    if (action === 'cancel') {
      await cancelBet(env.DB, id, session.discordId, now, String(form.get('scope') ?? WINNER));
      return back('ok=bet_back');
    }
    if (scope === null) return back('err=no_match');
    await placeBet(env.DB, id, session.discordId, pick, Number(form.get('coins')), marketPool(matches, scope), await ownKey(env.DB, id, session.discordId), now, scope);
    return back('ok=bet_on');
  } catch (error) {
    if (error instanceof RuleError) return back(`err=${error.code === 'bad_input' ? 'bet_input' : error.code}`);
    throw error;
  }
};
