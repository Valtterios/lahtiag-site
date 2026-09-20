import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { tokenMatches } from '../../../lib/minecraft';
import { markMatchSent, queuedMatches } from '../../../lib/cs2';

// The queue of matches waiting to go onto a server, and the claim that takes
// one off it.
//
// A Cloudflare Worker has no route to the game servers: they sit behind a
// home connection, and opening RCON to the internet to give it one would be
// a far worse trade than this. So the site does not push — it publishes, and
// the bridge on the AMP host (scripts/cs2/lag_match.py bridge) pulls. Same
// shape as the Minecraft whitelist bridge, for the same reason.
//
// GET  -> { matches: [{ id, server, url, best_of, team1, team2 }] }
// POST { id } -> { claimed: true } exactly once, false every time after.
//
// The claim is the important half. matchzy_loadmatch over an autostarted
// live match SILENTLY DESTROYS it — it wiped two live games — so a queue
// that kept re-offering the same match would be a machine for wrecking them.

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

function presentedToken(request: Request): string | null {
  const header = request.headers.get('x-matchzy-token');
  if (header) return header;
  const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return auth ? auth[1] : null;
}

function guard(request: Request): Response | null {
  if (!env.CS2_MATCH_TOKEN) return json({ error: 'The CS2 integration is not configured.' }, 404);
  if (!tokenMatches(presentedToken(request), env.CS2_MATCH_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...HEADERS, 'www-authenticate': 'Bearer' },
    });
  }
  return null;
}

export const GET: APIRoute = async ({ request, url }) => {
  const stop = guard(request);
  if (stop) return stop;
  const rows = await queuedMatches(env.DB);
  return json({
    matches: rows.map((row) => ({
      id: row.id,
      server: row.server,
      best_of: row.best_of,
      team1: row.name_a,
      team2: row.name_b,
      url: `${url.origin}/api/cs2/match/${row.id}.json`,
    })),
  });
};

export const POST: APIRoute = async ({ request }) => {
  const stop = guard(request);
  if (stop) return stop;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'The body is not JSON.' }, 400);
  }
  const id = Number((body as { id?: unknown })?.id);
  if (!Number.isInteger(id)) return json({ error: 'Which match? POST {"id": <number>}.' }, 400);
  return json({ claimed: await markMatchSent(env.DB, id, Math.floor(Date.now() / 1000)) });
};
