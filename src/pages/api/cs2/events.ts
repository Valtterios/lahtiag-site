import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { tokenMatches } from '../../../lib/minecraft';
import { applyCS2Event, parseEvent } from '../../../lib/cs2';

// Where the CS2 servers report what is happening.
//
// MatchZy posts every event to `matchzy_remote_log_url` with the shared
// token in the header named by `matchzy_remote_log_header_key` (which
// `matchzy_match_token` sets to X-MatchZy-Token). Most events are not our
// business — kills, grenades, demo progress — and are answered 200 and
// dropped, because the plugin keeps a RETRY QUEUE: anything we answer with
// an error comes back, again and again. So the only non-2xx here is a
// genuinely bad token.
//
// Results reach the bracket through setBracketGames/setBracketWinner, the
// same functions the board's own buttons call, so a server-reported result
// advances the draw and can be corrected afterwards exactly like a
// hand-entered one.

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

function presentedToken(request: Request): string | null {
  const header = request.headers.get('x-matchzy-token');
  if (header) return header;
  const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return auth ? auth[1] : null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!env.CS2_MATCH_TOKEN) return json({ error: 'The CS2 integration is not configured.' }, 404);
  if (!tokenMatches(presentedToken(request), env.CS2_MATCH_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...HEADERS, 'www-authenticate': 'Bearer' },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Not JSON is not retryable either; saying so and accepting it stops a
    // malformed delivery being redelivered for the rest of the evening.
    return json({ ok: true, applied: 'unparseable' });
  }

  const event = parseEvent(body);
  if (!event) return json({ ok: true, applied: 'ignored' });

  const result = await applyCS2Event(env.DB, event, Math.floor(Date.now() / 1000));
  return json({ ok: true, event: event.kind, ...result });
};

export const GET: APIRoute = () => json({ error: 'The servers POST here.' }, 405);
