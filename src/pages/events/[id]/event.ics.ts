import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getEvent } from '../../../lib/db';

// "Add to calendar": one event as an .ics file.

function icsDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

export const GET: APIRoute = async ({ params, url }) => {
  const id = Number(params.id);
  const event = Number.isInteger(id) ? await getEvent(env.DB, id) : null;
  if (!event) return new Response('no such event', { status: 404 });
  const now = Math.floor(Date.now() / 1000);
  const description = [event.organizers ? `Organized by ${event.organizers}` : '', event.description ?? '', `${url.origin}/events/${event.id}`]
    .filter(Boolean)
    .join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LahtiAG//lahtiag.fi//EN',
    'BEGIN:VEVENT',
    `UID:event-${event.id}@lahtiag.fi`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(event.starts_at)}`,
    `DTEND:${icsDate(event.ends_at ?? event.starts_at + 3 * 3600)}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${url.origin}/events/${event.id}`,
    ...(event.cancelled_at !== null ? ['STATUS:CANCELLED'] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const slug = event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}.ics"`,
      'cache-control': 'public, max-age=300',
    },
  });
};
