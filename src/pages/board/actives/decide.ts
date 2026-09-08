import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../../lib/guard';
import { requireAnyBoard } from '../../../lib/board-access';
import { setActive, RuleError } from '../../../lib/db';
import { applyRoles, loadRoleConfig } from '../../../lib/roles';
import { postBoardLine } from '../../../lib/board-channel';

// Approve or revoke an active from the board page. The same decision the
// buttons in the board channel make, so it takes the same gate: any board
// member, the Discord Board role included. The channel hears the outcome,
// since this one didn't happen on its buttons.

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const back = '/board/actives';
  const access = await requireAnyBoard(request, env);
  if (!access.ok) return redirect(`${back}?err=${access.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const id = Number(form.get('id'));
  const action = String(form.get('action') ?? '');
  if (!Number.isInteger(id) || (action !== 'approve' && action !== 'revoke')) {
    return redirect(`${back}?err=bad_input`, 303);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    const entry = await setActive(env.DB, id, action === 'approve', access.who, now);
    const roles = await applyRoles(await loadRoleConfig(env, env.DB), entry);
    locals.cfContext.waitUntil(
      postBoardLine(
        env.DB,
        env,
        action === 'approve'
          ? `✅ **${entry.full_name}** is an active now, approved by ${access.who}.`
          : `↩️ **${entry.full_name}** is no longer an active (by ${access.who}).`,
      ),
    );
    return redirect(`${back}?ok=${action}${roles.failed.length > 0 ? '&roles=failed' : ''}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
