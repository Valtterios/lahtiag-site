import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { publishAnnouncement, setAnnouncementMessages } from '../../lib/db';
import { postNews } from '../../lib/news';

// Publish a draft post: it appears on the news page and goes to Discord.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect('/announcements?err=bad_input', 303);
  const post = await publishAnnouncement(env.DB, id, Math.floor(Date.now() / 1000));
  if (!post) return redirect('/announcements?err=missing', 303);
  if (env.DISCORD_WEBHOOK_URL && !post.discord_message_id) {
    const messages = await postNews(env.DB, env.DISCORD_WEBHOOK_URL, post);
    if (messages) await setAnnouncementMessages(env.DB, id, messages);
    // The site has it either way; Discord is told so, or the board is.
    else return redirect('/announcements?ok=published_nodiscord', 303);
  }
  return redirect('/announcements?ok=published', 303);
};
