import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { currentSession } from '../../lib/guard';
import { memberStats } from '../../lib/db';
import { profileCardPng } from '../../lib/profile-card';
import { cleanText } from '../../lib/raster';

// The signed-in person's own stats card, as shown on the membership page.

export const GET: APIRoute = async ({ request }) => {
  const session = await currentSession(request, env);
  if (!session) return new Response('sign in', { status: 401, headers: { 'cache-control': 'no-store' } });
  const stats = await memberStats(env.DB, session.discordId, Math.floor(Date.now() / 1000));
  const png = await profileCardPng(cleanText(session.username) || 'Member', stats);
  return new Response(png as unknown as BodyInit, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
};
