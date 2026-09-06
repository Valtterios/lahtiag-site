import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { updateAnnouncement, setAnnouncementCover, RuleError } from '../../lib/db';
import { editWebhookMessage, editWebhookMessageFile } from '../../lib/discord';
import { newsText, newsCoverFile, parsePing } from '../../lib/news';
import { helsinkiToUnix } from '../../lib/time';

// Rewrite a post: title and body always; the ping and the publish time
// while it is a draft; a new cover any time. A published post's Discord
// message follows, text and picture.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect('/announcements?err=bad_input', 303);

  // The schedule fields come only on a draft's form; both empty = a plain draft.
  let publishAt: number | null | undefined;
  if (form.has('publish_date') || form.has('publish_time')) {
    const date = String(form.get('publish_date') ?? '').trim();
    const time = String(form.get('publish_time') ?? '').trim();
    publishAt = date === '' && time === '' ? null : helsinkiToUnix(date, time || '09:00');
    if (publishAt === null && (date !== '' || time !== '')) return redirect('/announcements?err=bad_time', 303);
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const post = await updateAnnouncement(env.DB, id, {
      title: String(form.get('title') ?? ''),
      body_md: String(form.get('body') ?? ''),
      ping: form.has('ping') ? parsePing(String(form.get('ping') ?? '')) : undefined,
      publish_at: publishAt,
    });
    if (!post) return redirect('/announcements?err=missing', 303);
    const cover = form.get('cover');
    let newCover = false;
    if (cover instanceof File && cover.size > 0) {
      await setAnnouncementCover(env.DB, id, cover.type, await cover.arrayBuffer(), now);
      newCover = true;
    }
    if (post.draft === 0 && post.discord_message_id && env.DISCORD_WEBHOOK_URL) {
      await editWebhookMessage(env.DISCORD_WEBHOOK_URL, post.discord_message_id, newsText(post));
      const file = newCover ? await newsCoverFile(env.DB, id) : null;
      if (file) await editWebhookMessageFile(env.DISCORD_WEBHOOK_URL, post.discord_message_id, file);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`/announcements?err=${error.code === 'bad_input' ? 'bad_input' : error.code}`, 303);
    throw error;
  }
  return redirect('/announcements?ok=edited', 303);
};
