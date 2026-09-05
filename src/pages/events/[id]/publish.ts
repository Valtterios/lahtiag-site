import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { publishEvent, setEventMessageId, RuleError } from '../../../lib/db';
import { postWebhook, eventAnnouncement } from '../../../lib/discord';

// Publish a draft: it lists, takes signups and sells from now on, and the
// announcement goes to Discord (its message id is kept for later edits).

export const POST: APIRoute = async ({ request, params, redirect, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  try {
    const event = await publishEvent(env.DB, id, Math.floor(Date.now() / 1000));
    if (env.DISCORD_WEBHOOK_URL && !event.discord_message_id) {
      const messageId = await postWebhook(
        env.DISCORD_WEBHOOK_URL,
        eventAnnouncement({
          title: event.title,
          startsAt: event.starts_at,
          endsAt: event.ends_at,
          organizers: event.organizers,
          teamSize: event.team_size,
          url: `${url.origin}/events/${id}`,
        }),
      );
      if (messageId) await setEventMessageId(env.DB, id, messageId);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(`${back}?ok=published`, 303);
};
