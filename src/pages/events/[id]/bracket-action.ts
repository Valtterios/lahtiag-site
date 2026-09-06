import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import {
  generateBracket,
  deleteBracket,
  setBracketWinner,
  clearBracketWinner,
  RuleError,
  getBracket,
  goLiveBracket,
  setBracketSeeding,
  replaceBracketParticipant,
} from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';
import { later, postBracketOut, postResult, postRevert, dropLiveBracket, refreshLiveBracket } from '../../../lib/event-channel';

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}/bracket`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const action = String(form.get('action') ?? '');
  const round = Number(form.get('round'));
  const slot = Number(form.get('slot'));
  if ((action === 'winner' || action === 'undo') && (!Number.isInteger(round) || !Number.isInteger(slot))) {
    return redirect(`${back}?err=missing`, 303);
  }

  try {
    if (action === 'generate' || action === 'regenerate') {
      const redraw = (await getBracket(env.DB, id)).length > 0;
      await generateBracket(env.DB, id);
      // Generating groups loose players into teams; a big event's voice channels follow.
      syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, Math.floor(Date.now() / 1000));
      // A redraw of a live bracket takes the pinned one down until it goes live again.
      if (redraw) later(locals.cfContext, dropLiveBracket(env.DB, env, id));
      return redirect(`${back}?ok=drafted`, 303);
    } else if (action === 'live') {
      const fresh = await goLiveBracket(env.DB, id, Math.floor(Date.now() / 1000));
      if (fresh) later(locals.cfContext, postBracketOut(env.DB, env, id, url.origin, false));
      return redirect(`${back}?ok=live`, 303);
    } else if (action === 'seed') {
      const count = (await getBracket(env.DB, id)).filter((m) => m.round === 1).length;
      const pick = (name: string): string | null => {
        const value = String(form.get(name) ?? '').trim();
        return value === '' ? null : value;
      };
      const pairs = Array.from({ length: count }, (_, slot): [string | null, string | null] => [pick(`a${slot}`), pick(`b${slot}`)]);
      await setBracketSeeding(env.DB, id, pairs);
      return redirect(`${back}?ok=seeded`, 303);
    } else if (action === 'replace') {
      await replaceBracketParticipant(env.DB, id, String(form.get('from') ?? ''), String(form.get('to') ?? ''));
      later(locals.cfContext, refreshLiveBracket(env.DB, env, id, url.origin, Math.floor(Date.now() / 1000)));
      return redirect(`${back}?ok=replaced`, 303);
    } else if (action === 'delete') {
      await deleteBracket(env.DB, id);
      later(locals.cfContext, dropLiveBracket(env.DB, env, id));
      return redirect(`/events/${id}`, 303);
    } else if (action === 'winner') {
      await setBracketWinner(env.DB, id, round, slot, String(form.get('winner') ?? ''));
      later(locals.cfContext, postResult(env.DB, env, id, url.origin, round, slot));
    } else if (action === 'undo') {
      await clearBracketWinner(env.DB, id, round, slot);
      later(locals.cfContext, postRevert(env.DB, env, id, url.origin, round, slot));
    } else {
      return redirect(`${back}?err=csrf`, 303);
    }
  } catch (error) {
    if (error instanceof RuleError) {
      // Generation failures surface on the event page, where the button is.
      const target = action === 'generate' || action === 'regenerate' ? `/events/${id}` : back;
      return redirect(`${target}?err=${error.code}`, 303);
    }
    throw error;
  }
  return redirect(back, 303);
};
