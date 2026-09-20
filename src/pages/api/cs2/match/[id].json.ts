import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { tokenMatches } from '../../../../lib/minecraft';
import { buildMatchConfig, getCS2Match } from '../../../../lib/cs2';

// The match config a CS2 server pulls for itself.
//
// The board sends a bracket match to a server, which sets
// `matchzy_loadmatch_url` to this address; MatchZy fetches it and loads the
// match. The server dials us, never the other way round — there is no route
// into the home connection the servers sit behind, and exposing RCON to the
// internet to make one would be a far worse trade than this.
//
// MatchZy sends the shared token as X-MatchZy-Token (it is also accepted as
// a bearer token, because `matchzy_match_token` wires it up as the match
// load Authorization header too).

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: HEADERS });

function presentedToken(request: Request): string | null {
  const header = request.headers.get('x-matchzy-token');
  if (header) return header;
  const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return auth ? auth[1] : null;
}

export const GET: APIRoute = async ({ request, params }) => {
  if (!env.CS2_MATCH_TOKEN) return json({ error: 'The CS2 integration is not configured.' }, 404);
  if (!tokenMatches(presentedToken(request), env.CS2_MATCH_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...HEADERS, 'www-authenticate': 'Bearer' },
    });
  }

  const id = Number(params.id);
  const row = await getCS2Match(env.DB, id);
  if (!row) return json({ error: 'No such match.' }, 404);
  // A withdrawn match must not be loadable again from a stale URL still
  // sitting in a server's persisted config.
  if (row.status === 'cancelled') return json({ error: 'That match was withdrawn.' }, 410);

  return json(buildMatchConfig(row));
};
