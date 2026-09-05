import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../../lib/guard';
import { requireBoard } from '../../../lib/board';
import {
  decideApplication,
  updateRegisterEntry,
  setRegisterStatus,
  eraseRegisterEntry,
  RuleError,
} from '../../../lib/db';
import { parseApplication, LIMITS, MEMBER_TYPES, type MemberType } from '../../../lib/register';

// Every board write on one register entry, dispatched on `action`:
// approve | reject | update | former | member | erase. Google step-up
// (board.ts) and CSRF checked, like every register route.

export const POST: APIRoute = async ({ request, redirect, params }) => {
  const id = Number(params.id);
  const back = Number.isInteger(id) ? `/register/${id}` : '/register';
  const board = await requireBoard(request, env);
  if (!board.ok) return redirect(`${back}?err=${board.reason}`, 303);
  if (!Number.isInteger(id)) return redirect('/register?err=missing', 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const action = String(form.get('action') ?? '');
  const now = Math.floor(Date.now() / 1000);

  try {
    switch (action) {
      case 'approve':
        await decideApplication(env.DB, id, 'approve', board.email, now);
        return redirect('/register?ok=approved', 303);
      case 'reject':
        await decideApplication(env.DB, id, 'reject', board.email, now);
        return redirect('/register?ok=rejected', 303);
      case 'former':
      case 'member':
        await setRegisterStatus(env.DB, id, action, now);
        return redirect(`${back}?ok=${action}`, 303);
      case 'erase': {
        const gone = await eraseRegisterEntry(env.DB, id);
        return redirect(gone ? '/register?ok=erased' : '/register?err=missing', 303);
      }
      case 'update': {
        const parsed = parseApplication(form, false);
        if (!parsed.ok) return redirect(`${back}?err=bad_input`, 303);
        const discordIdRaw = String(form.get('discord_id') ?? '').trim();
        if (discordIdRaw && !/^\d{5,25}$/.test(discordIdRaw)) {
          return redirect(`${back}?err=bad_input`, 303);
        }
        const boardNote = String(form.get('board_note') ?? '')
          .trim()
          .slice(0, LIMITS.board_note);
        const typeRaw = String(form.get('member_type') ?? '');
        const memberType = MEMBER_TYPES.find((t): t is MemberType => t === typeRaw);
        if (!memberType) return redirect(`${back}?err=bad_input`, 303);
        await updateRegisterEntry(
          env.DB,
          id,
          parsed.value,
          { discord_id: discordIdRaw || null, board_note: boardNote || null, member_type: memberType },
          now,
        );
        return redirect(`${back}?ok=saved`, 303);
      }
      default:
        return redirect(`${back}?err=bad_input`, 303);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
