import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { bearerToken, tokenMatches } from '../../../lib/minecraft';
import { parsePlaytimeBatch, applyPlaytimeBatch } from '../../../lib/playtime';

// The Minecraft host's play-time sync (scripts/minecraft/playtime-sync.py)
// posts here, one batch per server per run, with the same bearer token as
// the whitelist pull. A batch is applied once: the same (instance, seq)
// again answers ok with duplicate: true and changes nothing.

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export const POST: APIRoute = async ({ request }) => {
  if (!env.MINECRAFT_WHITELIST_TOKEN) return json({ error: 'The whitelist is not configured.' }, 404);
  if (!tokenMatches(bearerToken(request), env.MINECRAFT_WHITELIST_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...HEADERS, 'www-authenticate': 'Bearer' } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'The body is not JSON.' }, 400);
  }
  const batch = parsePlaytimeBatch(body);
  if (!batch) return json({ error: 'Not a batch: instance, seq, server and deltas of {uuid, day, minutes}.' }, 400);
  const result = await applyPlaytimeBatch(env.DB, batch, Math.floor(Date.now() / 1000));
  return json({ ok: true, ...result });
};

export const GET: APIRoute = () => json({ error: 'POST a batch.' }, 405);
