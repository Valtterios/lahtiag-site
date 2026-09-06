import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { getAnnouncement, getAnnouncementCover, setAnnouncementCover, deleteAnnouncementCover, RuleError } from '../../../lib/db';
import { newsCoverFile } from '../../../lib/news';
import { editWebhookMessageFile } from '../../../lib/discord';

// A news post's cover picture. GET serves it (cached a day; the page links
// it with the upload time as a version). POST, for the board, replaces or
// removes it: JPEG, PNG or WebP up to 1.5 MB. A published post's Discord
// message gets the new picture too.

export const GET: APIRoute = async ({ params, request }) => {
  const id = Number(params.id);
  const cover = Number.isInteger(id) ? await getAnnouncementCover(env.DB, id) : null;
  if (!cover || cover.bytes.byteLength === 0) return new Response('no cover', { status: 404, headers: { 'cache-control': 'no-store' } });
  const etag = `"news-${id}-${cover.updated_at}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(cover.bytes, {
    headers: {
      'content-type': cover.content_type,
      'content-length': String(cover.bytes.byteLength),
      'cache-control': 'public, max-age=86400',
      etag,
    },
  });
};

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);
  try {
    if (form.get('action') === 'remove') {
      await deleteAnnouncementCover(env.DB, id);
      return redirect('/announcements?ok=cover_removed', 303);
    }
    const file = form.get('cover');
    if (!(file instanceof File) || file.size === 0) return redirect('/announcements?err=cover_missing', 303);
    await setAnnouncementCover(env.DB, id, file.type, await file.arrayBuffer(), Math.floor(Date.now() / 1000));
    const post = await getAnnouncement(env.DB, id);
    const cover = await newsCoverFile(env.DB, id);
    if (post?.discord_message_id && env.DISCORD_WEBHOOK_URL && cover) await editWebhookMessageFile(env.DISCORD_WEBHOOK_URL, post.discord_message_id, cover);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`/announcements?err=${error.code === 'bad_input' ? 'cover_bad' : error.code}`, 303);
    throw error;
  }
  return redirect('/announcements?ok=cover_saved', 303);
};
