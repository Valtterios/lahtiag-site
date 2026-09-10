import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { bearerToken, tokenMatches } from '../../../lib/minecraft';
import { parseProgressBatch, applyProgressBatch } from '../../../lib/gtnh';

// The Minecraft host's bridge (scripts/minecraft/bridge/bridge.mjs) posts
// each player's quest book progress here, with the same bearer token as
// the whitelist pull. A snapshot, not a delta: sending it twice changes
// nothing. The answer carries each player's tier and whether it went up,
// for the bridge to say so in the chat channel.

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
  const batch = parseProgressBatch(body);
  if (!batch) return json({ error: 'Not a snapshot: server and players of {uuid, name, lines, quests_done, quests_total}.' }, 400);
  const result = await applyProgressBatch(env.DB, batch, Math.floor(Date.now() / 1000));
  return json({ ok: true, ...result });
};

export const GET: APIRoute = () => json({ error: 'POST a snapshot.' }, 405);
