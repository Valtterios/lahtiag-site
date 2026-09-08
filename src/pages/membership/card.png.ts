import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { currentSession } from '../../lib/guard';
import { cardFace, memberCardPng } from '../../lib/member-card';

// The signed-in person's own card, as the membership page shows it and as
// /profile posts it in Discord: the same picture from the same code, so
// the preview on the page cannot drift from what everyone else sees.
// ?back=1 for the other side.

export const GET: APIRoute = async ({ request, url }) => {
  const session = await currentSession(request, env);
  if (!session) return new Response('sign in', { status: 401, headers: { 'cache-control': 'no-store' } });
  const face = await cardFace(
    env.DB,
    { discordId: session.discordId, name: session.username, avatarHash: session.avatarHash, board: session.isAdmin },
    Math.floor(Date.now() / 1000),
  );
  const png = await memberCardPng(face, url.searchParams.get('back') === '1');
  return new Response(png as unknown as BodyInit, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
};
