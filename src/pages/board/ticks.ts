import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../lib/guard';
import { requireAnyBoard } from '../../lib/board-access';
import { RuleError } from '../../lib/db';
import { addTickKind, giveTick, removeTick, saveTickKind, setTickKindRetired } from '../../lib/ticks';
import { claimDecisionDm, decideClaim } from '../../lib/claims';
import { dmUser } from '../../lib/discord';
import { seasonStartYear } from '../../lib/activity';
import { postBoardLine } from '../../lib/board-channel';
import { addPassLevel, removePassLevel, savePassLevel } from '../../lib/pass';

// Every board write about ticks, dispatched on `action`: give | remove |
// kind_add | kind_save | kind_retire | kind_restore, and the season pass's
// levels, level_add | level_save | level_remove. Posted from the
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
  const action = String(form.get('action') ?? '');
  // Level writes land back on the levels section, with their own flash keys.
  const isLevel = action.startsWith('level_');
  const go = (key: 'ok' | 'err', value: string) => redirect(`${back}${back.includes('?') ? '&' : '?'}${key}=${value}#${isLevel ? 'levels' : 'ticks'}`, 303);
  const access = await requireAnyBoard(request, env);
  if (!access.ok) return go('err', access.reason);
  if (!(await checkCsrf(request, form))) return go('err', 'csrf');

  const now = Math.floor(Date.now() / 1000);
  // A positive integer, null for an empty field, NaN for anything else.
  const num = (name: string): number | null => {
    const raw = String(form.get(name) ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : Number.NaN;
  };
  const levelInput = () => ({
    xp: form.get('xp'),
    name: form.get('name'),
    reward: form.get('reward'),
    sponsor: form.get('sponsor'),
    role_id: form.get('role_id'),
  });
  const kindInput = () => ({
    name: form.get('name'),
    description: form.get('description'),
    xp: form.get('xp'),
    season_cap: form.get('season_cap'),
    period: form.get('period') ?? 'season',
    claimable: form.get('claimable'),
    auto_source: form.get('auto_source'),
    auto_step: form.get('auto_step'),
  });

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
        // A changed XP applies to every tick of the current season; past
        // seasons keep what they were paid.
        await saveTickKind(env.DB, id, kindInput(), seasonStartYear(now));
        return go('ok', 'kind_saved');
      }
      case 'level_add': {
        const level = await addPassLevel(env.DB, seasonStartYear(now), levelInput(), access.who, now);
        locals.cfContext.waitUntil(
          postBoardLine(env.DB, env, `🎫 Battle pass level added: **${level.level} · ${level.name}** at ${level.xp} XP, reward ${level.reward}${level.sponsor ? ` from ${level.sponsor}` : ''} (by ${access.who}).`),
        );
        return go('ok', 'level_added');
      }
      case 'level_save': {
        const id = num('level_id');
        if (!id) return go('err', 'level_bad_input');
        await savePassLevel(env.DB, id, levelInput(), now);
        return go('ok', 'level_saved');
      }
      case 'level_remove': {
        const id = num('level_id');
        if (!id) return go('err', 'level_bad_input');
        return (await removePassLevel(env.DB, id)) ? go('ok', 'level_removed') : go('err', 'level_missing');
      }
      case 'claim_approve':
      case 'claim_decline': {
        const id = num('claim_id');
        if (!id) return go('err', 'tick_bad_input');
        const result = await decideClaim(env.DB, id, action === 'claim_approve' ? 'approve' : 'decline', access.who, now);
        if (!result) return go('err', 'tick_missing');
        if (env.DISCORD_BOT_TOKEN) {
          locals.cfContext.waitUntil(dmUser(env.DISCORD_BOT_TOKEN, result.claim.discord_id, claimDecisionDm(result.claim, new URL(request.url).origin)));
        }
        return go('ok', action === 'claim_approve' ? 'claim_approved' : 'claim_declined');
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
    if (error instanceof RuleError) return go('err', `${isLevel ? 'level' : 'tick'}_${error.code}`);
    throw error;
  }
};
