// The hourly job (a Cron Trigger on the Worker, src/worker.ts): the
// day-before reminder into each event's channel, the "signups are open"
// post when an opening moment passes, waitlist promotions that still
// need telling, and a fresh read of Discord's Interested counts. Every
// step is recorded on the event so a rerun never repeats it.

import type { D1Database } from '@cloudflare/workers-types';
import { getEvent, listUpcomingEvents, listEndedEventsWithRole, type EventWithCounts } from './db';
import { postWebhook, NO_MENTIONS } from './discord';
import { syncInterest, archiveEventDiscord } from './event-discord';
import { announcePromotions, postEventLine } from './event-channel';
import { formatHelsinki } from './time';

export const REMINDER_WINDOW = 24 * 3600; // the reminder goes out within the last day before the start
const OPENING_GRACE = 24 * 3600; // an opening older than this is not announced any more
export const ARCHIVE_AFTER = 7 * 24 * 3600; // a week after the end, the event's Discord role goes

type Env = { DISCORD_BOT_TOKEN?: string; DISCORD_WEBHOOK_URL?: string };

// Pure: which events get their reminder now.
export function dueReminders<T extends Pick<EventWithCounts, 'starts_at' | 'reminder_sent_at' | 'published_at' | 'cancelled_at'>>(events: T[], now: number): T[] {
  return events.filter((e) => e.published_at !== null && e.cancelled_at === null && e.reminder_sent_at === null && e.starts_at > now && e.starts_at - now <= REMINDER_WINDOW);
}

// Pure: which events' signups opened since the last run.
export function dueOpenings<T extends Pick<EventWithCounts, 'signups_open_at' | 'open_posted_at' | 'published_at' | 'cancelled_at' | 'starts_at'>>(events: T[], now: number): T[] {
  return events.filter(
    (e) => e.published_at !== null && e.cancelled_at === null && e.open_posted_at === null && e.signups_open_at !== null && e.signups_open_at <= now && now - e.signups_open_at < OPENING_GRACE && e.starts_at > now,
  );
}

function safe(text: string): string {
  return text.replace(/[`*_~|>\[\]()@#]/g, '').trim();
}

export function reminderLine(event: Pick<EventWithCounts, 'title' | 'starts_at' | 'location' | 'yes_count' | 'team_size' | 'teams_count'>, url: string): string {
  const where = event.location ? ` · ${safe(event.location)}` : '';
  const who = event.team_size !== null ? `${event.teams_count} teams in` : `${event.yes_count} going`;
  return `⏰ Tomorrow: **${safe(event.title)}**, ${formatHelsinki(event.starts_at)}${where}. ${who}.\n${url}`;
}

export function openingLine(event: Pick<EventWithCounts, 'title' | 'starts_at' | 'interest_count'>, url: string): string {
  const interest = event.interest_count > 0 ? ` ${event.interest_count} people said they're interested.` : '';
  return `🟢 Signups are open for **${safe(event.title)}** (${formatHelsinki(event.starts_at)}).${interest}\n${url}`;
}

export interface HourlySummary {
  reminders: number;
  openings: number;
  promotions: number;
  interest: number;
  archived: number;
}

export async function runHourly(db: D1Database, env: Env, origin: string, now: number): Promise<HourlySummary> {
  const upcoming = await listUpcomingEvents(db, now, false);
  const summary: HourlySummary = { reminders: 0, openings: 0, promotions: 0, interest: 0, archived: 0 };

  for (const event of dueReminders(upcoming, now)) {
    const url = `${origin}/events/${event.id}`;
    const line = reminderLine(event, url);
    // Into the event's channel with the role pinged; without a channel, the announcements channel, no ping.
    const posted = event.discord_channel_id ? await postEventLine(db, env, event.id, line, true) : env.DISCORD_WEBHOOK_URL ? (await postWebhook(env.DISCORD_WEBHOOK_URL, line, NO_MENTIONS)) !== null : false;
    await db.prepare('UPDATE events SET reminder_sent_at = ?2 WHERE id = ?1').bind(event.id, now).run();
    if (posted) summary.reminders++;
  }

  for (const event of dueOpenings(upcoming, now)) {
    const url = `${origin}/events/${event.id}`;
    const line = openingLine(event, url);
    if (env.DISCORD_WEBHOOK_URL) await postWebhook(env.DISCORD_WEBHOOK_URL, line, NO_MENTIONS);
    if (event.discord_channel_id) await postEventLine(db, env, event.id, line, true);
    await db.prepare('UPDATE events SET open_posted_at = ?2 WHERE id = ?1').bind(event.id, now).run();
    summary.openings++;
  }

  summary.promotions = await announcePromotions(db, env, now);

  for (const event of upcoming) {
    if (!event.discord_event_id) continue;
    const fresh = await getEvent(db, event.id);
    if (fresh && (await syncInterest(db, env, fresh, now))) summary.interest++;
  }

  // A week after the end: the role goes, the channels stay for the board.
  for (const event of await listEndedEventsWithRole(db, now - ARCHIVE_AFTER)) {
    if ((await archiveEventDiscord(db, env, event.id)) !== 'nothing') summary.archived++;
  }
  return summary;
}
