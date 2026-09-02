import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { adminRemoveSignup, RuleError } from '../../../lib/db';

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  try {
    await adminRemoveSignup(env.DB, id, String(form.get('discord_id') ?? ''));
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
