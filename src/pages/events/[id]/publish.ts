import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { publishEvent, setEventMessageId, RuleError } from '../../../lib/db';
import { postWebhook, postWebhookWithFile, eventAnnouncement } from '../../../lib/discord';
import { syncScheduledEvent, setUpEventDiscord, coverFile } from '../../../lib/event-discord';

// Publish a draft: it lists, takes signups and sells from now on, the
// announcement goes to Discord (its message id is kept for later edits),
// and the bot puts it on Discord's event list and, by the choice on the
// card, makes the event's role with one channel or its own category.

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
      const content = eventAnnouncement({
        title: event.title,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        organizers: event.organizers,
        teamSize: event.team_size,
        url: `${url.origin}/events/${id}`,
      });
      // With a cover, the picture rides along and the link's preview card stays off.
      const cover = await coverFile(env.DB, id);
      const messageId = cover ? await postWebhookWithFile(env.DISCORD_WEBHOOK_URL, content, cover) : await postWebhook(env.DISCORD_WEBHOOK_URL, content);
      if (messageId) await setEventMessageId(env.DB, id, messageId);
    }
    const now = Math.floor(Date.now() / 1000);
    await syncScheduledEvent(env.DB, env, id, url.origin, now);
    const setup = String(form.get('discord_setup') ?? (form.get('discord_channel') === 'on' ? 'channel' : 'none'));
    if (setup === 'channel' || setup === 'category') await setUpEventDiscord(env.DB, env, id, url.origin, admin.session.discordId, now, setup);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(`${back}?ok=published`, 303);
};
