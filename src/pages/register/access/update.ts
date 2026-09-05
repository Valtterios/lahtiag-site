import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../../lib/guard';
import { requireBoard, allowedBoardEmails, WORKSPACE_DOMAIN } from '../../../lib/board';
import { addRegisterAdmin, removeRegisterAdmin } from '../../../lib/db';

// Grant or revoke register access, by someone who already has it. Only
// Workspace addresses; never your own removal (no self-lockout); never a
// fixed account from the var (those are the recovery path).

export const POST: APIRoute = async ({ request, redirect }) => {
  const board = await requireBoard(request, env);
  if (!board.ok) return redirect(`/register/access?err=${board.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/register/access?err=csrf', 303);

  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || !email.endsWith(`@${WORKSPACE_DOMAIN}`) || email.length > 120) {
    return redirect('/register/access?err=bad_email', 303);
  }
  const action = String(form.get('action') ?? '');
  const now = Math.floor(Date.now() / 1000);

  if (action === 'add') {
    await addRegisterAdmin(env.DB, email, board.email, now);
    return redirect('/register/access?ok=access_added', 303);
  }
  if (action === 'remove') {
    if (email === board.email) return redirect('/register/access?err=self', 303);
    if (allowedBoardEmails(env.REGISTER_ADMINS).includes(email)) {
      return redirect('/register/access?err=fixed', 303);
    }
    await removeRegisterAdmin(env.DB, email);
    return redirect('/register/access?ok=access_removed', 303);
  }
  return redirect('/register/access?err=bad_email', 303);
};
