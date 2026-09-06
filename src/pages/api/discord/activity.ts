import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { bearerToken, tokenMatches } from '../../../lib/minecraft';
import { parseActivityBatch, applyActivityBatch } from '../../../lib/activity';

// The Discord activity listener on auraserver (scripts/discord-listener)
// posts its counts here, a batch at a time, with the DISCORD_ACTIVITY_TOKEN
// secret as a bearer token. A batch is applied once: the same (instance,
// seq) again answers ok with duplicate: true and changes nothing, so the
// listener can retry freely.

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export const POST: APIRoute = async ({ request }) => {
  if (!env.DISCORD_ACTIVITY_TOKEN) return json({ error: 'The activity listener is not configured.' }, 404);
  if (!tokenMatches(bearerToken(request), env.DISCORD_ACTIVITY_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...HEADERS, 'www-authenticate': 'Bearer' } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'The body is not JSON.' }, 400);
  }
  const batch = parseActivityBatch(body);
  if (!batch) return json({ error: 'Not a batch: instance, seq and deltas of {discord_id, month, messages, voice_minutes}.' }, 400);
  const result = await applyActivityBatch(env.DB, batch, Math.floor(Date.now() / 1000));
  return json({ ok: true, ...result });
};

export const GET: APIRoute = () => json({ error: 'POST a batch.' }, 405);
