// The hourly job (a Cron Trigger on the Worker, src/worker.ts): the
// day-before reminder into each event's channel, the "signups are open"
// post when an opening moment passes, waitlist promotions that still
// need telling, and a fresh read of Discord's Interested counts. Every
// step is recorded on the event so a rerun never repeats it.

import type { D1Database } from '@cloudflare/workers-types';
import {
  getEvent,
  listUpcomingEvents,
  listEndedEventsWithRole,
  listTicketTypes,
  listDueAnnouncements,
  publishAnnouncement,
  setAnnouncementMessages,
  listResults,
  countNewMembers,
  getSettings,
  setSetting,
  listEventsEndedBetween,
  listAttendees,
  memberStats,
  recordMilestone,
  EVENT_MILESTONES,
  type EventWithCounts,
  type TicketTypeWithSales,
  type ResultRow,
} from './db';
import { postWebhook, NO_MENTIONS, SUPPRESS_EMBEDS } from './discord';
import { syncInterest, archiveEventDiscord } from './event-discord';
import { announcePromotions, postEventLine } from './event-channel';
import { formatHelsinki } from './time';
import { refreshEventAnnouncement } from './announce';
import { postNews } from './news';
import { pruneActivityBatches } from './activity';
import { prunePlaytimeBatches } from './playtime';

export const REMINDER_WINDOW = 24 * 3600; // the reminder goes out within the last day before the start
const OPENING_GRACE = 24 * 3600; // an opening older than this is not announced any more
export const ARCHIVE_AFTER = 7 * 24 * 3600; // a week after the end, the event's Discord role goes

type Env = { DISCORD_BOT_TOKEN?: string; DISCORD_WEBHOOK_URL?: string; WELCOME_WEBHOOK_URL?: string };

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

// Pure: the earliest ticket deadline still ahead, when it falls within
// the next day and the line was not sent yet. Types without a deadline
// close at the start, which the day-before reminder already covers.
export function dueSalesReminder<T extends Pick<EventWithCounts, 'starts_at' | 'sales_reminder_sent_at' | 'published_at' | 'cancelled_at'>>(
  event: T,
  types: Pick<TicketTypeWithSales, 'active' | 'sales_close_at' | 'quantity' | 'sold'>[],
  now: number,
): { closesAt: number; left: number | null } | null {
  if (event.published_at === null || event.cancelled_at !== null || event.sales_reminder_sent_at !== null) return null;
  const open = types.filter((t) => t.active === 1 && t.sales_close_at !== null && t.sales_close_at > now);
  if (open.length === 0) return null;
  const closesAt = Math.min(...open.map((t) => t.sales_close_at!));
  if (closesAt - now > REMINDER_WINDOW) return null;
  const capped = open.filter((t) => t.quantity !== null);
  const left = capped.length === open.length ? capped.reduce((n, t) => n + Math.max(0, t.quantity! - t.sold), 0) : null;
  return { closesAt, left };
}

export function salesLine(event: Pick<EventWithCounts, 'title'>, closesAt: number, left: number | null, url: string): string {
  const stock = left === null ? '' : left === 0 ? ' Sold out.' : ` ${left} left.`;
  return `🎟️ Ticket sales for **${safe(event.title)}** close ${formatHelsinki(closesAt)}.${stock}\n${url}`;
}

function safe(text: string): string {
  return text.replace(/[`*_~|>\[\]()@#]/g, '').trim();
}

export function reminderLine(event: Pick<EventWithCounts, 'title' | 'starts_at' | 'location' | 'yes_count' | 'team_size' | 'teams_count'>, url: string): string {
  const where = event.location ? ` · ${safe(event.location)}` : '';
  const who = event.team_size !== null ? `${event.teams_count} teams in` : event.yes_count > 0 ? `${event.yes_count} going` : 'no signups yet';
  return `⏰ Tomorrow: **${safe(event.title)}**, ${formatHelsinki(event.starts_at)}${where}. ${who}.\n${url}`;
}

export function openingLine(event: Pick<EventWithCounts, 'title' | 'starts_at' | 'interest_count'>, url: string): string {
  const interest = event.interest_count > 0 ? ` ${event.interest_count} ${event.interest_count === 1 ? 'person' : 'people'} said they're interested.` : '';
  return `🟢 Signups are open for **${safe(event.title)}** (${formatHelsinki(event.starts_at)}).${interest}\n${url}`;
}

// Helsinki weekday (0 = Sunday) and hour, for the Monday digest.
export function helsinkiClock(now: number): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Helsinki', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(now * 1000));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  return { weekday, hour };
}

// The Monday post for the general channel: the next two weeks, last
// week's champion, new members.
export function digestText(
  upcoming: Pick<EventWithCounts, 'id' | 'title' | 'starts_at' | 'yes_count' | 'interest_count' | 'team_size' | 'teams_count'>[],
  champions: Pick<ResultRow, 'champion_name' | 'title'>[],
  newMembers: number,
  origin: string,
): string | null {
  if (upcoming.length === 0 && champions.length === 0 && newMembers === 0) return null;
  const lines = ['📬 **This week at LahtiAG**'];
  if (upcoming.length === 0) lines.push('Nothing on the calendar for the next two weeks yet. Ideas? Tell the board.');
  for (const e of upcoming) {
    const who = e.team_size !== null ? `${e.teams_count} teams` : `${e.yes_count} going`;
    const heart = e.interest_count > 0 ? ` · ♡ ${e.interest_count}` : '';
    lines.push(`• ${formatHelsinki(e.starts_at)} · **${safe(e.title)}** · ${who}${heart} · ${origin}/events/${e.id}`);
  }
  for (const c of champions) lines.push(`🏆 Last week's champion: **${safe(c.champion_name)}** (${safe(c.title)})`);
  if (newMembers > 0) lines.push(`👋 ${newMembers} new ${newMembers === 1 ? 'member' : 'members'} joined last week. Welcome!`);
  return lines.join('\n');
}

export function milestoneLine(name: string, attended: number): string {
  const suffix = attended === 1 ? 'st' : attended === 2 ? 'nd' : attended === 3 ? 'rd' : 'th';
  return `🎉 **${safe(name)}** just attended their ${attended}${suffix} LahtiAG event!`;
}

export interface HourlySummary {
  digest: number;
  milestones: number;
  news: number;
  reminders: number;
  sales: number;
  openings: number;
  promotions: number;
  interest: number;
  archived: number;
}

export async function runHourly(db: D1Database, env: Env, origin: string, now: number): Promise<HourlySummary> {
  const upcoming = await listUpcomingEvents(db, now, false);
  const summary: HourlySummary = { digest: 0, milestones: 0, news: 0, reminders: 0, sales: 0, openings: 0, promotions: 0, interest: 0, archived: 0 };

  // News written ahead: published and posted at its time.
  for (const draft of await listDueAnnouncements(db, now)) {
    const post = await publishAnnouncement(db, draft.id, now);
    if (!post) continue;
    if (env.DISCORD_WEBHOOK_URL) {
      const messages = await postNews(db, env.DISCORD_WEBHOOK_URL, post);
      if (messages) await setAnnouncementMessages(db, post.id, messages);
    }
    summary.news++;
  }

  for (const event of dueReminders(upcoming, now)) {
    const url = `${origin}/events/${event.id}`;
    const line = reminderLine(event, url);
    // Into the event's channel with the role pinged; without a channel, the announcements channel, no ping.
    const posted = event.discord_channel_id ? await postEventLine(db, env, event.id, line, true) : env.DISCORD_WEBHOOK_URL ? (await postWebhook(env.DISCORD_WEBHOOK_URL, line, NO_MENTIONS, SUPPRESS_EMBEDS)) !== null : false;
    await db.prepare('UPDATE events SET reminder_sent_at = ?2 WHERE id = ?1').bind(event.id, now).run();
    if (posted) summary.reminders++;
  }

  for (const event of upcoming) {
    const due = dueSalesReminder(event, await listTicketTypes(db, event.id), now);
    if (!due) continue;
    const url = `${origin}/events/${event.id}`;
    const line = salesLine(event, due.closesAt, due.left, url);
    if (env.DISCORD_WEBHOOK_URL) await postWebhook(env.DISCORD_WEBHOOK_URL, line, NO_MENTIONS, SUPPRESS_EMBEDS);
    if (event.discord_channel_id) await postEventLine(db, env, event.id, line, true);
    await db.prepare('UPDATE events SET sales_reminder_sent_at = ?2 WHERE id = ?1').bind(event.id, now).run();
    summary.sales++;
  }

  for (const event of dueOpenings(upcoming, now)) {
    const url = `${origin}/events/${event.id}`;
    const line = openingLine(event, url);
    if (env.DISCORD_WEBHOOK_URL) await postWebhook(env.DISCORD_WEBHOOK_URL, line, NO_MENTIONS, SUPPRESS_EMBEDS);
    if (event.discord_channel_id) await postEventLine(db, env, event.id, line, true);
    await db.prepare('UPDATE events SET open_posted_at = ?2 WHERE id = ?1').bind(event.id, now).run();
    summary.openings++;
  }

  summary.promotions = await announcePromotions(db, env, now);

  // The activity listener's batch receipts are only needed to catch a retry; a month is plenty.
  await pruneActivityBatches(db, now - 30 * 24 * 3600);
  await prunePlaytimeBatches(db, now - 30 * 24 * 3600);

  for (const event of upcoming) {
    if (!event.discord_event_id) continue;
    const fresh = await getEvent(db, event.id);
    if (fresh && (await syncInterest(db, env, fresh, now))) summary.interest++;
  }

  // Monday at nine, Helsinki time: the digest, once a week, to the general channel.
  const clock = helsinkiClock(now);
  if (env.WELCOME_WEBHOOK_URL && clock.weekday === 1 && clock.hour === 9) {
    const last = Number((await getSettings(db)).digest_sent_at ?? 0);
    if (now - last > 6 * 86400) {
      const soon = upcoming.filter((e) => e.starts_at < now + 14 * 86400);
      const champions = (await listResults(db, 10)).filter((r) => r.starts_at >= now - 7 * 86400 && r.starts_at < now);
      const text = digestText(soon, champions, await countNewMembers(db, now - 7 * 86400), origin);
      if (text) await postWebhook(env.WELCOME_WEBHOOK_URL, text, NO_MENTIONS, SUPPRESS_EMBEDS);
      await setSetting(db, 'digest_sent_at', String(now), 'bot', now);
      summary.digest++;
    }
  }

  // Attendance milestones for events that ended in the last day, for
  // members on the leaderboard (all but the hidden); each is told once.
  if (env.WELCOME_WEBHOOK_URL) {
    for (const event of await listEventsEndedBetween(db, now - 86400, now)) {
      for (const person of await listAttendees(db, event.id)) {
        if (person.leaderboard !== 1) continue;
        const stats = await memberStats(db, person.discord_id, now);
        if (!EVENT_MILESTONES.includes(stats.attended)) continue;
        if (!(await recordMilestone(db, person.discord_id, 'events', stats.attended, now))) continue;
        await postWebhook(env.WELCOME_WEBHOOK_URL, milestoneLine(person.username, stats.attended), NO_MENTIONS, SUPPRESS_EMBEDS);
        summary.milestones++;
      }
    }
  }

  // Once an hour (the first run of the hour): the counts on every upcoming
  // announcement, in case a change slipped past the event-driven refresh.
  if (new Date(now * 1000).getUTCMinutes() < 15) {
    for (const event of upcoming) if (event.discord_message_id) await refreshEventAnnouncement(db, env, event.id, origin);
  }

  // A week after the end: the role goes, the channels stay for the board.
  for (const event of await listEndedEventsWithRole(db, now - ARCHIVE_AFTER)) {
    if ((await archiveEventDiscord(db, env, event.id)) !== 'nothing') summary.archived++;
  }
  return summary;
}
