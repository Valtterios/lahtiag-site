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

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}/bracket`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const action = String(form.get('action') ?? '');

  try {
    if (action === 'generate' || action === 'regenerate') {
      await generateBracket(env.DB, id);
    } else if (action === 'delete') {
      await deleteBracket(env.DB, id);
      return redirect(`/events/${id}`, 303);
    } else if (action === 'winner') {
      await setBracketWinner(
        env.DB,
        id,
        Number(form.get('round')),
        Number(form.get('slot')),
        String(form.get('winner') ?? ''),
      );
    } else if (action === 'undo') {
      await clearBracketWinner(env.DB, id, Number(form.get('round')), Number(form.get('slot')));
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
