import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { getEventCover, setEventCover, deleteEventCover, RuleError } from '../../../lib/db';

// An event's cover image. GET serves it (cached a day; the page links it
// with the upload time as a version). POST, for the board, replaces or
// removes it: JPEG, PNG or WebP up to 1.5 MB.

export const GET: APIRoute = async ({ params, request }) => {
  const id = Number(params.id);
  const cover = Number.isInteger(id) ? await getEventCover(env.DB, id) : null;
  // Never let an empty body be cached as the image for a day.
  if (!cover || cover.bytes.byteLength === 0) return new Response('no cover', { status: 404, headers: { 'cache-control': 'no-store' } });
  const etag = `"${id}-${cover.updated_at}"`;
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
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  try {
    if (form.get('action') === 'remove') {
      await deleteEventCover(env.DB, id);
      return redirect(`${back}?ok=cover_removed`, 303);
    }
    const file = form.get('cover');
    if (!(file instanceof File) || file.size === 0) return redirect(`${back}?err=cover_missing`, 303);
    await setEventCover(env.DB, id, file.type, await file.arrayBuffer(), Math.floor(Date.now() / 1000));
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code === 'bad_input' ? 'cover_bad' : error.code}`, 303);
    throw error;
  }
  return redirect(`${back}?ok=cover_saved`, 303);
};
