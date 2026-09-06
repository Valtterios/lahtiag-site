import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { whitelistPlayers, bearerToken, tokenMatches } from '../../../lib/minecraft';

// The Minecraft server pulls its whitelist from here every few minutes
// (scripts/minecraft/whitelist-sync.py), with the MINECRAFT_WHITELIST_TOKEN
// secret as a bearer token. JSON by default (names, and the players with
// their Mojang UUIDs), one name per line with ?format=text. Never cached.

const NO_STORE = { 'cache-control': 'no-store' };

export const GET: APIRoute = async ({ request, url }) => {
  if (!env.MINECRAFT_WHITELIST_TOKEN) return new Response('The whitelist is not configured.', { status: 404, headers: NO_STORE });
  if (!tokenMatches(bearerToken(request), env.MINECRAFT_WHITELIST_TOKEN)) {
    return new Response('Unauthorized', { status: 401, headers: { ...NO_STORE, 'www-authenticate': 'Bearer' } });
  }
  const players = await whitelistPlayers(env.DB);
  const names = players.map((p) => p.name);
  if (url.searchParams.get('format') === 'text') {
    return new Response(names.map((n) => `${n}\n`).join(''), { headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } });
  }
  return new Response(JSON.stringify({ names, players, count: names.length, generated_at: Math.floor(Date.now() / 1000) }), {
    headers: { ...NO_STORE, 'content-type': 'application/json' },
  });
};
