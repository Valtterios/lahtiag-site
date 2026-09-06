import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getEvent, getBracket } from '../../../lib/db';
import { participantNames } from '../../../lib/event-channel';
import { bracketPng } from '../../../lib/bracket-image';
import { formatHelsinki } from '../../../lib/time';

// The bracket as a picture, the same one the bot posts: the link preview
// of the bracket page, and handy for a screen. Public like the bracket
// page; a draft event's, or a draft bracket's, is not served.

export const GET: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  const event = Number.isInteger(id) ? await getEvent(env.DB, id) : null;
  const matches = event && event.published_at !== null && event.bracket_live_at !== null ? await getBracket(env.DB, id) : [];
  if (!event || matches.length === 0) return new Response('no bracket', { status: 404, headers: { 'cache-control': 'no-store' } });
  const png = await bracketPng({
    matches,
    names: await participantNames(env.DB, id),
    title: event.title,
    subtitle: `updated ${formatHelsinki(Math.floor(Date.now() / 1000))}`,
  });
  return new Response(png as unknown as BodyInit, {
    headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength), 'cache-control': 'public, max-age=60' },
  });
};
