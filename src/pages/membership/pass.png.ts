import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { currentSession } from '../../lib/guard';
import { seasonSummary } from '../../lib/season';
import { passCardPng, homePage } from '../../lib/pass-card';

// The signed-in person's own season pass as a picture, the one /pass
// posts in Discord, so the page and the bot never disagree. ?page=N for
// a season with more rungs than one picture holds; without it, the page
// with the next rung to reach.

export const GET: APIRoute = async ({ request, url }) => {
  const session = await currentSession(request, env);
  if (!session) return new Response('sign in', { status: 401, headers: { 'cache-control': 'no-store' } });
  const now = Math.floor(Date.now() / 1000);
  const season = await seasonSummary(env.DB, session.discordId, now);
  const input = { name: session.username, season: season.label, progress: season.pass, held: season.held };
  const page = Number(url.searchParams.get('page') ?? '') || homePage(season.pass);
  const png = await passCardPng(input, page);
  return new Response(png as unknown as BodyInit, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
};
