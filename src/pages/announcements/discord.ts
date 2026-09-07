import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { getAnnouncement, setAnnouncementMessages } from '../../lib/db';
import { postNews } from '../../lib/news';

// Post a published post on Discord after the fact: for when the webhook
// refused it at publish time (a post too long, Discord down) and the
// site kept it. Only for posts that are not on Discord yet.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect('/announcements?err=bad_input', 303);
  const post = await getAnnouncement(env.DB, id);
  if (!post || post.draft === 1) return redirect('/announcements?err=missing', 303);
  if (post.discord_message_id) return redirect('/announcements?err=discord_exists', 303);
  if (!env.DISCORD_WEBHOOK_URL) return redirect('/announcements?err=discord_failed', 303);
  const messages = await postNews(env.DB, env.DISCORD_WEBHOOK_URL, post);
  if (!messages) return redirect('/announcements?err=discord_failed', 303);
  await setAnnouncementMessages(env.DB, id, messages);
  return redirect(`/announcements?ok=discord_posted#post-${id}`, 303);
};
