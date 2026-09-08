import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { adminRemoveSignup, RuleError } from '../../../lib/db';
import { syncEventRolesInBackground } from '../../../lib/event-discord';
import { refreshAnnouncementInBackground } from '../../../lib/announce';
import { announcePromotionsInBackground } from '../../../lib/event-channel';

export const POST: APIRoute = async ({ request, params, redirect, locals, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}#participants`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf#participants`, 303);

  try {
    await adminRemoveSignup(env.DB, id, String(form.get('discord_id') ?? ''));
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}#participants`, 303);
    throw error;
  }
  announcePromotionsInBackground(locals.cfContext, env.DB, env, Math.floor(Date.now() / 1000));
  syncEventRolesInBackground(locals.cfContext, env.DB, env, [id], Math.floor(Date.now() / 1000));
  refreshAnnouncementInBackground(locals.cfContext, env.DB, env, [id], url.origin);
  return redirect(`${back}?ok=signup_removed#participants`, 303);
};
