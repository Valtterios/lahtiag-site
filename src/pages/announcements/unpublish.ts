import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { unpublishAnnouncement } from '../../lib/db';
import { deleteNewsMessages, newsMessages } from '../../lib/news';

// Take a published post back to a draft: off the news page and off
// Discord, every message of it. Publish sends it out again, in the
// current shape, with the ping it has.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect('/announcements?err=bad_input', 303);
  const was = await unpublishAnnouncement(env.DB, id);
  if (!was) return redirect('/announcements?err=missing', 303);
  const onDiscord = newsMessages(was);
  if (onDiscord && env.DISCORD_WEBHOOK_URL) await deleteNewsMessages(env.DISCORD_WEBHOOK_URL, onDiscord);
  return redirect(`/announcements?ok=unpublished#post-${id}`, 303);
};
