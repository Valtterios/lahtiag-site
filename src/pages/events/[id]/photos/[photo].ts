import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getEventPhoto } from '../../../../lib/db';

// One photo, or its thumbnail with ?thumb. Cached a day; the id never
// changes its picture.

export const GET: APIRoute = async ({ params, request, url }) => {
  const id = Number(params.photo);
  const photo = Number.isInteger(id) ? await getEventPhoto(env.DB, id, url.searchParams.has('thumb')) : null;
  if (!photo || photo.bytes.byteLength === 0) return new Response('no photo', { status: 404, headers: { 'cache-control': 'no-store' } });
  const etag = `"p${id}-${url.searchParams.has('thumb') ? 't' : 'f'}-${photo.created_at}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(photo.bytes, {
    headers: { 'content-type': photo.content_type, 'content-length': String(photo.bytes.byteLength), 'cache-control': 'public, max-age=86400', etag },
  });
};
