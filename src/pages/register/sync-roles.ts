import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../lib/guard';
import { requireBoard } from '../../lib/board';
import { syncAllRoles } from '../../lib/roles';

// Reconcile every linked member's Discord roles with the register, for
// when something drifted (a role removed by hand, the bot added later).
// One click applies at most 40 changes; the summary says what is left.

export const POST: APIRoute = async ({ request, redirect }) => {
  const board = await requireBoard(request, env);
  if (!board.ok) return redirect(`/register?err=${board.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/register?err=csrf', 303);

  const summary = await syncAllRoles(env, env.DB);
  if (summary.error) return redirect(`/register?err=roles_${summary.error}`, 303);
  const params = new URLSearchParams({
    ok: 'synced',
    planned: String(summary.planned),
    applied: String(summary.applied),
    failed: String(summary.failed),
    remaining: String(summary.remaining),
  });
  return redirect(`/register?${params}#roles`, 303);
};
