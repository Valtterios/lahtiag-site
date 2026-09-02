import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { listUpcomingEvents } from '../lib/db';

// iCalendar feed of upcoming (and ongoing) events: subscribe once in any
// calendar app and LahtiAG events keep appearing. Times are emitted as UTC
// instants, so subscribers in any timezone see the right moment.

function icsDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export const GET: APIRoute = async ({ url }) => {
  const now = Math.floor(Date.now() / 1000);
  const events = await listUpcomingEvents(env.DB, now);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LahtiAG//lahtiag.fi//EN',
    'X-WR-CALNAME:LahtiAG events',
    'X-WR-TIMEZONE:Europe/Helsinki',
  ];
  for (const event of events) {
    const description = [
      event.organizers ? `Organized by ${event.organizers}` : '',
      event.description ?? '',
      `${url.origin}/events/${event.id}`,
    ]
      .filter(Boolean)
      .join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:event-${event.id}@lahtiag.fi`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(event.starts_at)}`,
      // No end recorded: assume three hours so calendar blocks look sane.
      `DTEND:${icsDate(event.ends_at ?? event.starts_at + 3 * 3600)}`,
      `SUMMARY:${escapeText(event.title)}`,
      `DESCRIPTION:${escapeText(description)}`,
      `URL:${url.origin}/events/${event.id}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');

  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'public, max-age=900',
    },
  });
};
