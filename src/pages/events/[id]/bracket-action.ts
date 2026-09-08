import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import {
  addBracket,
  createBracket,
  generateBracket,
  deleteBracket,
  renameBracket,
  listBrackets,
  getBracketRow,
  mainBracket,
  setBracketWinner,
  clearBracketWinner,
  RuleError,
  getBracket,
  listSignups,
  goLiveBracket,
  setBracketSeeding,
  replaceBracketParticipant,
} from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';
import {
  later,
  postBracketOut,
  postResult,
  postRevert,
  dropLiveBracket,
  dropPinnedBrackets,
  refreshLiveBracket,
  refreshEventBrackets,
  notifyTeamPlacement,
} from '../../../lib/event-channel';

// Everything the board does to a draw. Which draw is in the form:
// an event with one bracket never says, and reads exactly as it did
// before there could be more than one.

async function pageFor(eventId: number, bracketId: number | null): Promise<string> {
  const many = (await listBrackets(env.DB, eventId)).length > 1;
  return many && bracketId !== null
    ? `/events/${eventId}/bracket?b=${bracketId}`
    : `/events/${eventId}/bracket`;
}

async function backTo(eventId: number, bracketId: number | null, key?: 'ok' | 'err', value?: string): Promise<string> {
  const page = await pageFor(eventId, bracketId);
  if (!key || !value) return page;
  return `${page}${page.includes('?') ? '&' : '?'}${key}=${value}`;
}

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const eventPage = `/events/${id}`;
  const plain = `${eventPage}/bracket`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${plain}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${plain}?err=csrf`, 303);

  const action = String(form.get('action') ?? '');
  const bracketRaw = String(form.get('bracket_id') ?? '').trim();
  const asked = bracketRaw === '' ? null : Number(bracketRaw);
  if (asked !== null && !Number.isInteger(asked)) return redirect(`${plain}?err=missing`, 303);
  const round = Number(form.get('round'));
  const slot = Number(form.get('slot'));
  if ((action === 'winner' || action === 'undo') && (!Number.isInteger(round) || !Number.isInteger(slot))) {
    return redirect(await backTo(id, asked, 'err', 'missing'), 303);
  }
  const now = Math.floor(Date.now() / 1000);

  // The bracket the form is about: the one it names, or the event's
  // first. Only "add" makes a new one, and a bracket from another event
  // is nobody's business here.
  const chosen = asked === null ? await mainBracket(env.DB, id) : await getBracketRow(env.DB, asked);
  if (chosen !== null && chosen.event_id !== id) return redirect(`${plain}?err=missing`, 303);

  try {
    if (action === 'generate' || action === 'regenerate' || action === 'add') {
      // Entrants ticked on the form narrow the draw; none ticked means
      // the whole roster, which is what the one-click button sends.
      const ticked = form.getAll('entrant').map(String).filter((key) => key !== '');
      const entrants = form.get('pick_entrants') === 'on' ? ticked : undefined;
      const loose = entrants === undefined
        ? (await listSignups(env.DB, id)).filter((s) => s.status === 'yes' && s.event_team_id === null).map((s) => s.discord_id)
        : [];
      let target: number;
      if (action === 'add') {
        target = await addBracket(env.DB, id, String(form.get('name') ?? '').trim() || null, now, entrants);
      } else {
        target = chosen?.id ?? (await createBracket(env.DB, id, null, now));
        const redraw = chosen !== null && (await getBracket(env.DB, chosen.id)).length > 0;
        await generateBracket(env.DB, target, now, entrants);
        // A redraw of a live bracket takes its pinned message down until it goes live again.
        if (redraw) later(locals.cfContext, dropLiveBracket(env.DB, env, target));
      }
      // Drawing the whole roster groups loose players into teams; a big
      // event's voice channels follow, and the grouped hear about it.
      if (loose.length > 0) {
        syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, now);
        const placed = (await listSignups(env.DB, id))
          .filter((s) => loose.includes(s.discord_id) && s.event_team_id !== null)
          .map((s) => ({ discordId: s.discord_id, teamId: s.event_team_id! }));
        later(locals.cfContext, notifyTeamPlacement(env.DB, env, id, placed, url.origin));
      }
      // The event may just have gone from one bracket to two, which is
      // when the pinned ones start needing their names.
      if (action === 'add') later(locals.cfContext, refreshEventBrackets(env.DB, env, id, url.origin, now));
      return redirect(await backTo(id, target, 'ok', action === 'add' ? 'added' : 'drafted'), 303);
    }

    if (!chosen) return redirect(`${plain}?err=missing`, 303);

    if (action === 'live') {
      const fresh = await goLiveBracket(env.DB, chosen.id, now);
      if (fresh) later(locals.cfContext, postBracketOut(env.DB, env, chosen.id, url.origin, false));
      return redirect(await backTo(id, chosen.id, 'ok', 'live'), 303);
    } else if (action === 'rename') {
      await renameBracket(env.DB, chosen.id, String(form.get('name') ?? ''));
      later(locals.cfContext, refreshLiveBracket(env.DB, env, chosen.id, url.origin, now));
      return redirect(await backTo(id, chosen.id, 'ok', 'renamed'), 303);
    } else if (action === 'seed') {
      const count = (await getBracket(env.DB, chosen.id)).filter((m) => m.round === 1).length;
      const pick = (name: string): string | null => {
        const value = String(form.get(name) ?? '').trim();
        return value === '' ? null : value;
      };
      const pairs = Array.from({ length: count }, (_, slot): [string | null, string | null] => [pick(`a${slot}`), pick(`b${slot}`)]);
      await setBracketSeeding(env.DB, chosen.id, pairs);
      return redirect(await backTo(id, chosen.id, 'ok', 'seeded'), 303);
    } else if (action === 'replace') {
      await replaceBracketParticipant(env.DB, chosen.id, String(form.get('from') ?? ''), String(form.get('to') ?? ''));
      later(locals.cfContext, refreshLiveBracket(env.DB, env, chosen.id, url.origin, now));
      return redirect(await backTo(id, chosen.id, 'ok', 'replaced'), 303);
    } else if (action === 'delete') {
      await deleteBracket(env.DB, chosen.id);
      later(locals.cfContext, dropPinnedBrackets(env.DB, env, id, [chosen]));
      // Down to one bracket, the names come off the pinned messages again.
      later(locals.cfContext, refreshEventBrackets(env.DB, env, id, url.origin, now));
      return redirect(`${plain}?ok=bracket_deleted`, 303);
    } else if (action === 'winner') {
      await setBracketWinner(env.DB, chosen.id, round, slot, String(form.get('winner') ?? ''));
      later(locals.cfContext, postResult(env.DB, env, chosen.id, url.origin, round, slot));
    } else if (action === 'undo') {
      await clearBracketWinner(env.DB, chosen.id, round, slot);
      later(locals.cfContext, postRevert(env.DB, env, chosen.id, url.origin, round, slot));
    } else {
      return redirect(`${plain}?err=csrf`, 303);
    }
  } catch (error) {
    if (error instanceof RuleError) {
      // A draw that could not be made surfaces on the event page when the
      // button that failed is the one that lives there.
      const onEventPage = (action === 'generate' || action === 'regenerate') && asked === null;
      const target = onEventPage ? `${eventPage}?err=${error.code}` : await backTo(id, asked ?? chosen?.id ?? null, 'err', error.code);
      return redirect(target, 303);
    }
    throw error;
  }
  return redirect(await backTo(id, chosen.id), 303);
};
