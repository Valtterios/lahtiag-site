import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getEvent, getBracket, listBrackets, pickBracket } from '../../../lib/db';
import { participantNames } from '../../../lib/event-channel';
import { bracketPng } from '../../../lib/bracket-image';
import { formatHelsinki } from '../../../lib/time';

// The bracket as a picture, the same one the bot posts: the link preview
// of the bracket page, and handy for a screen. ?b= picks which of the
// event's brackets, defaulting to its first. Public like the bracket
// page; a draft event's, or a draft bracket's, is not served.

export const GET: APIRoute = async ({ params, url }) => {
  const id = Number(params.id);
  const event = Number.isInteger(id) ? await getEvent(env.DB, id) : null;
  const askedRaw = url.searchParams.get('b');
  const asked = askedRaw === null || askedRaw.trim() === '' ? null : Number(askedRaw);
  const bracket = event && event.published_at !== null ? await pickBracket(env.DB, id, asked) : null;
  const matches = bracket !== null && bracket.live_at !== null ? await getBracket(env.DB, bracket.id) : [];
  if (!event || !bracket || matches.length === 0) return new Response('no bracket', { status: 404, headers: { 'cache-control': 'no-store' } });
  const only = (await listBrackets(env.DB, id)).length < 2;
  const png = await bracketPng({
    matches,
    names: await participantNames(env.DB, id),
    title: only ? event.title : `${event.title} — ${bracket.name}`,
    subtitle: `updated ${formatHelsinki(Math.floor(Date.now() / 1000))}`,
  });
  return new Response(png as unknown as BodyInit, {
    headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength), 'cache-control': 'public, max-age=60' },
  });
};
