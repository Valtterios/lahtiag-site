import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { setSignupsClosed, RuleError } from '../../../lib/db';
import { later, postSignups } from '../../../lib/event-channel';
import { refreshEventAnnouncement } from '../../../lib/announce';

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const closing = String(form.get('action')) === 'close';
  try {
    await setSignupsClosed(env.DB, id, closing, Math.floor(Date.now() / 1000));
    // The event's own channel hears about it.
    later(locals.cfContext, postSignups(env.DB, env, id, closing));
    later(locals.cfContext, refreshEventAnnouncement(env.DB, env, id, url.origin));
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
