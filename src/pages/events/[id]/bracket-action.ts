import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import {
  generateBracket,
  deleteBracket,
  setBracketWinner,
  clearBracketWinner,
  RuleError,
} from '../../../lib/db';
import { syncTeamVoiceChannelsInBackground } from '../../../lib/event-discord';

export const POST: APIRoute = async ({ request, params, redirect, locals }) => {
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
      await generateBracket(env.DB, id);
      // Generating groups loose players into teams; a big event's voice channels follow.
      syncTeamVoiceChannelsInBackground(locals.cfContext, env.DB, env, id, Math.floor(Date.now() / 1000));
    } else if (action === 'delete') {
      await deleteBracket(env.DB, id);
      return redirect(`/events/${id}`, 303);
    } else if (action === 'winner') {
      await setBracketWinner(env.DB, id, round, slot, String(form.get('winner') ?? ''));
    } else if (action === 'undo') {
      await clearBracketWinner(env.DB, id, round, slot);
    } else {
      return redirect(`${back}?err=csrf`, 303);
    }
  } catch (error) {
    if (error instanceof RuleError) {
      // Generation failures surface on the event page, where the button is.
      const target = action === 'generate' ? `/events/${id}` : back;
      return redirect(`${target}?err=${error.code}`, 303);
    }
    throw error;
  }
  return redirect(back, 303);
};
