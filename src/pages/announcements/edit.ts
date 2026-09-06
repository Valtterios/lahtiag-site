import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { updateAnnouncement, RuleError } from '../../lib/db';
import { editWebhookMessage } from '../../lib/discord';
import { newsText, parsePing } from '../../lib/news';

// Rewrite a post. A published one's Discord message follows.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect('/announcements?err=bad_input', 303);
  try {
    const post = await updateAnnouncement(env.DB, id, {
      title: String(form.get('title') ?? ''),
      body_md: String(form.get('body') ?? ''),
      ping: form.has('ping') ? parsePing(String(form.get('ping') ?? '')) : undefined,
    });
    if (!post) return redirect('/announcements?err=missing', 303);
    if (post.draft === 0 && post.discord_message_id && env.DISCORD_WEBHOOK_URL) {
      await editWebhookMessage(env.DISCORD_WEBHOOK_URL, post.discord_message_id, newsText(post));
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect('/announcements?err=bad_input', 303);
    throw error;
  }
  return redirect('/announcements?ok=edited', 303);
};
