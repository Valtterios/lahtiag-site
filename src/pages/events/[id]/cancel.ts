import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { cancelEvent, uncancelEvent, setCancelMessageId, RuleError } from '../../../lib/db';
import { postWebhook, deleteWebhookMessage } from '../../../lib/discord';
import { formatHelsinki } from '../../../lib/time';

// Cancel an event, or put a cancelled one back. Cancelling posts a line
// to the announcements channel and remembers it; reinstating removes that
// line and posts that the event is on again.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const action = String(form.get('action') ?? 'cancel');

  try {
    if (action === 'uncancel') {
      const event = await uncancelEvent(env.DB, id);
      if (env.DISCORD_WEBHOOK_URL) {
        if (event.cancel_message_id) await deleteWebhookMessage(env.DISCORD_WEBHOOK_URL, event.cancel_message_id);
        await postWebhook(env.DISCORD_WEBHOOK_URL, `✅ Back on: **${event.title}** (${formatHelsinki(event.starts_at)})`);
      }
      await setCancelMessageId(env.DB, id, null);
      return redirect(`${back}?ok=reinstated`, 303);
    }
    const event = await cancelEvent(env.DB, id, Math.floor(Date.now() / 1000));
    if (env.DISCORD_WEBHOOK_URL) {
      const messageId = event.published_at === null ? null : await postWebhook(
        env.DISCORD_WEBHOOK_URL,
        `❌ Cancelled: **${event.title}** (was ${formatHelsinki(event.starts_at)})`,
      );
      if (messageId) await setCancelMessageId(env.DB, id, messageId);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
