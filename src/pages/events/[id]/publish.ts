import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { publishEvent, RuleError } from '../../../lib/db';
import { syncScheduledEvent, setUpEventDiscord } from '../../../lib/event-discord';
import { postEventAnnouncement } from '../../../lib/announce';

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
    void event;
    // The announcement, with the cover and the signup buttons.
    await postEventAnnouncement(env.DB, env, id, url.origin);
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
