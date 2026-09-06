import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { deleteEvent, RuleError } from '../../../lib/db';
import { deleteEventAnnouncement } from '../../../lib/announce';
import { deleteDiscordObjects, listEventChannels } from '../../../lib/event-discord';

// Permanent removal, signups and bracket included — for events that should
// never have existed. A real event that fell through is cancelled instead,
// which keeps its history.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/events/${id}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`/events/${id}?err=csrf`, 303);

  try {
    const channels = await listEventChannels(env.DB, id);
    const event = await deleteEvent(env.DB, id);
    await deleteEventAnnouncement(env.DB, env, event);
    // Its Discord role, channels, category and scheduled event, if it had them, go too.
    await deleteDiscordObjects(env, event, channels, true);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`/events/${id}?err=${error.code}`, 303);
    throw error;
  }
  return redirect('/events', 303);
};
