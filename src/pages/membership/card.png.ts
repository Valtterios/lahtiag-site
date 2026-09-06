import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { currentSession } from '../../lib/guard';
import { memberStats, isLeaderboardOptIn } from '../../lib/db';
import { seasonSummary } from '../../lib/season';
import { profileCardPng } from '../../lib/profile-card';
import { cleanText } from '../../lib/raster';

// The signed-in person's own stats card, as shown on the membership page.

export const GET: APIRoute = async ({ request }) => {
  const session = await currentSession(request, env);
  if (!session) return new Response('sign in', { status: 401, headers: { 'cache-control': 'no-store' } });
  const now = Math.floor(Date.now() / 1000);
  const stats = await memberStats(env.DB, session.discordId, now);
  // The season goes on the card unless the person has hidden themselves.
  const season = (await isLeaderboardOptIn(env.DB, session.discordId)) ? await seasonSummary(env.DB, session.discordId, now) : null;
  const png = await profileCardPng(cleanText(session.username) || 'Member', stats, season);
  return new Response(png as unknown as BodyInit, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
};
