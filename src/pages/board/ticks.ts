import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../lib/guard';
import { requireAnyBoard } from '../../lib/board-access';
import { RuleError } from '../../lib/db';
import { addTickKind, giveTick, removeTick, saveTickKind, setTickKindRetired } from '../../lib/ticks';
import { postBoardLine } from '../../lib/board-channel';

// Every board write about ticks, dispatched on `action`: give | remove |
// kind_add | kind_save | kind_retire | kind_restore. Posted from the
// season page and from an event's Manage participants; `back` says which,
// and only those two shapes are followed. A tick given is told to the
// board channel like any other board decision.

function safeBack(raw: string): string {
  if (/^\/events\/\d+$/.test(raw) || /^\/board\/season(\?season=\d{4})?$/.test(raw)) return raw;
  return '/board/season';
}

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const back = safeBack(String(form.get('back') ?? ''));
  const go = (key: 'ok' | 'err', value: string) => redirect(`${back}${back.includes('?') ? '&' : '?'}${key}=${value}#ticks`, 303);
  const access = await requireAnyBoard(request, env);
  if (!access.ok) return go('err', access.reason);
  if (!(await checkCsrf(request, form))) return go('err', 'csrf');

  const action = String(form.get('action') ?? '');
  const now = Math.floor(Date.now() / 1000);
  // A positive integer, null for an empty field, NaN for anything else.
  const num = (name: string): number | null => {
    const raw = String(form.get(name) ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : Number.NaN;
  };
  const kindInput = () => ({ name: form.get('name'), description: form.get('description'), xp: form.get('xp'), season_cap: form.get('season_cap'), period: form.get('period') ?? 'season' });

  try {
    switch (action) {
      case 'give': {
        const kindId = num('kind_id');
        const registerId = num('register_id');
        const eventId = num('event_id');
        if (!kindId || !registerId || Number.isNaN(eventId)) return go('err', 'tick_bad_input');
        const tick = await giveTick(env.DB, { kindId, registerId, eventId, note: form.get('note') }, access.who, now);
        locals.cfContext.waitUntil(
          postBoardLine(env.DB, env, `✅ **${tick.member}** got a tick: **${tick.kind}**${tick.event ? ` for ${tick.event}` : ''} (by ${access.who}).`),
        );
        return go('ok', 'tick_given');
      }
      case 'remove': {
        const id = num('tick_id');
        if (!id) return go('err', 'tick_bad_input');
        const gone = await removeTick(env.DB, id);
        return gone ? go('ok', 'tick_removed') : go('err', 'tick_missing');
      }
      case 'kind_add':
        await addTickKind(env.DB, kindInput(), access.who, now);
        return go('ok', 'kind_added');
      case 'kind_save': {
        const id = num('kind_id');
        if (!id) return go('err', 'tick_bad_input');
        // The season the page showed, so "apply to this season's ticks"
        // means the one the board was looking at.
        const season = num('apply_season');
        await saveTickKind(env.DB, id, kindInput(), season && !Number.isNaN(season) ? season : null);
        return go('ok', 'kind_saved');
      }
      case 'kind_retire':
      case 'kind_restore': {
        const id = num('kind_id');
        if (!id) return go('err', 'tick_bad_input');
        const done = await setTickKindRetired(env.DB, id, action === 'kind_retire', now);
        return done ? go('ok', action === 'kind_retire' ? 'kind_retired' : 'kind_restored') : go('err', 'tick_missing');
      }
      default:
        return go('err', 'tick_bad_input');
    }
  } catch (error) {
    if (error instanceof RuleError) return go('err', `tick_${error.code}`);
    throw error;
  }
};
