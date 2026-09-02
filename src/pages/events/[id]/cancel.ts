import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { cancelEvent, RuleError } from '../../../lib/db';
import { postWebhook } from '../../../lib/discord';
import { formatHelsinki } from '../../../lib/time';

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  try {
    const event = await cancelEvent(env.DB, id, Math.floor(Date.now() / 1000));
    if (env.DISCORD_WEBHOOK_URL) {
      await postWebhook(
        env.DISCORD_WEBHOOK_URL,
        `❌ Cancelled: **${event.title}** (was ${formatHelsinki(event.starts_at)})`,
      );
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
