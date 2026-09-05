import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { RuleError } from '../../../lib/db';
import { getProductImage, setProductImage, deleteProductImage } from '../../../lib/purchases';

// A product's picture. GET serves it (cached a day; pages link it with the
// upload time as a version). POST, for the board, replaces or removes it.

export const GET: APIRoute = async ({ params, request }) => {
  const id = Number(params.id);
  const image = Number.isInteger(id) ? await getProductImage(env.DB, id) : null;
  if (!image || image.bytes.byteLength === 0) return new Response('no image', { status: 404, headers: { 'cache-control': 'no-store' } });
  const etag = `"p${id}-${image.updated_at}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(image.bytes, {
    headers: {
      'content-type': image.content_type,
      'content-length': String(image.bytes.byteLength),
      'cache-control': 'public, max-age=86400',
      etag,
    },
  });
};

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = '/shop';
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  try {
    if (form.get('action') === 'remove') {
      await deleteProductImage(env.DB, id);
      return redirect(`${back}?ok=image_removed`, 303);
    }
    const file = form.get('image');
    if (!(file instanceof File) || file.size === 0) return redirect(`${back}?err=image_missing`, 303);
    await setProductImage(env.DB, id, file.type, await file.arrayBuffer(), Math.floor(Date.now() / 1000));
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code === 'bad_input' ? 'image_bad' : error.code}`, 303);
    throw error;
  }
  return redirect(`${back}?ok=image_saved`, 303);
};
