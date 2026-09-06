import type { APIRoute } from 'astro';
import { UUID } from '../../../../lib/minecraft';

// The face of a Minecraft skin, by account UUID, fetched from a public
// renderer and passed through this origin so the page's image policy and
// Discord embeds can use it. Cached a day at the edge and in the browser.

const SOURCES = (uuid: string) => [`https://crafatar.com/avatars/${uuid}?size=64&overlay`, `https://mc-heads.net/avatar/${uuid}/64`];

export const GET: APIRoute = async ({ params }) => {
  const uuid = String(params.uuid ?? '').toLowerCase();
  if (!UUID.test(uuid)) return new Response('bad id', { status: 404, headers: { 'cache-control': 'no-store' } });
  for (const url of SOURCES(uuid)) {
    try {
      const upstream = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } } as RequestInit);
      const type = upstream.headers.get('content-type') ?? '';
      if (upstream.ok && type.startsWith('image/')) {
        return new Response(upstream.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' } });
      }
    } catch {
      // the next renderer
    }
  }
  return new Response('no face', { status: 404, headers: { 'cache-control': 'no-store' } });
};
