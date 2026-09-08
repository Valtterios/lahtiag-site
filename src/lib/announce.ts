// The event announcement in the announcements channel, posted by the bot
// itself so it can carry buttons: I'm going, Maybe, Interested. A click
// arrives at the interactions endpoint and becomes a signup on the site
// under the same rules as the page. The channel is the one behind the
// announcements webhook, looked up once and remembered. When the bot
// cannot post there, the plain webhook message goes out as before.

import type { D1Database } from '@cloudflare/workers-types';
import { getEvent, getSettings, setSetting, setEventMessageId, isTicketed, type EventWithCounts } from './db';
import {
  createChannelMessage,
  createChannelMessageWithFile,
  editChannelMessage,
  deleteChannelMessage,
  fetchWebhookChannel,
  postWebhook,
  postWebhookWithFile,
  editWebhookMessage,
  deleteWebhookMessage,
  eventAnnouncement,
  SUPPRESS_EMBEDS,
  NO_MENTIONS,
} from './discord';
import { coverFile } from './event-discord';
import { pingPrefix, pingMentions } from './news';

export interface AnnounceEnv {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_WEBHOOK_URL?: string;
}

export async function announceChannel(db: D1Database, env: AnnounceEnv): Promise<string | null> {
  if (!env.DISCORD_WEBHOOK_URL) return null;
  const saved = (await getSettings(db)).announce_channel_id;
  if (saved) return saved;
  const found = await fetchWebhookChannel(env.DISCORD_WEBHOOK_URL);
  if (found) await setSetting(db, 'announce_channel_id', found, 'bot', Math.floor(Date.now() / 1000));
  return found;
}

// The counts line under the announcement, refreshed after every click.
export function countsLine(event: Pick<EventWithCounts, 'yes_count' | 'maybe_count' | 'interest_count' | 'team_size' | 'teams_count' | 'capacity'>): string {
  const going = event.team_size !== null ? `${event.teams_count} teams, ${event.yes_count} players` : `${event.yes_count}${event.capacity !== null ? ` / ${event.capacity}` : ''} going`;
  const parts = [going];
  if (event.maybe_count > 0) parts.push(`${event.maybe_count} maybe`);
  if (event.interest_count > 0) parts.push(`♡ ${event.interest_count} interested`);
  return `👥 ${parts.join(' · ')}`;
}

// The ping rides in the text, the way a news post's does: the mention
// stays visible in the message, and editing it later notifies nobody
// again — only the first posting rings.
export function announcementText(event: EventWithCounts, origin: string): string {
  const ping = pingPrefix(event.ping);
  const counts = countsLine(event);
  // Discord holds 2000 characters; the description takes what the rest
  // of the message leaves, with a little room to spare.
  const room = 1900 - ping.length - counts.length;
  return `${ping}${eventAnnouncement({
    title: event.title,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    organizers: event.organizers,
    teamSize: event.team_size,
    location: event.location,
    description: event.description,
    dateTba: event.date_tba === 1,
    room,
    url: `${origin}/events/${event.id}`,
  })}\n${counts}`;
}

// Buttons: signups for a plain event, a link to the tickets for a ticketed
// one, Interested always. Cancelled or closed events keep only the link.
export function announcementComponents(event: Pick<EventWithCounts, 'id' | 'cancelled_at' | 'signups_closed_at'>, ticketed: boolean, origin: string): unknown[] {
  const url = `${origin}/events/${event.id}`;
  if (event.cancelled_at !== null) return [];
  const buttons: unknown[] = [];
  if (event.signups_closed_at === null) {
    if (ticketed) buttons.push({ type: 2, style: 5, label: 'Tickets', url });
    else {
      buttons.push({ type: 2, style: 3, label: "I'm going", custom_id: `e:go:${event.id}` });
      buttons.push({ type: 2, style: 2, label: 'Maybe', custom_id: `e:maybe:${event.id}` });
    }
  }
  buttons.push({ type: 2, style: 1, label: 'Interested', custom_id: `e:heart:${event.id}`, emoji: { name: '💙' } });
  if (!ticketed || event.signups_closed_at !== null) buttons.push({ type: 2, style: 5, label: 'Details', url });
  return [{ type: 1, components: buttons }];
}

// Post the announcement (once) and remember its message id.
export async function postEventAnnouncement(db: D1Database, env: AnnounceEnv, eventId: number, origin: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const event = await getEvent(db, eventId);
  if (!event || event.discord_message_id) return;
  const text = announcementText(event, origin);
  const cover = await coverFile(db, eventId);
  const channel = env.DISCORD_BOT_TOKEN ? await announceChannel(db, env) : null;
  let messageId: string | null = null;
  if (channel && env.DISCORD_BOT_TOKEN) {
    const components = announcementComponents(event, await isTicketed(db, eventId), origin);
    const mentions = pingMentions(event.ping);
    // No link preview, ever: the announcement already carries the cover
    // picture, the buttons and the event's own words, and Discord's card
    // for the same link underneath is the fourth copy of it.
    const made = cover
      ? await createChannelMessageWithFile(env.DISCORD_BOT_TOKEN, channel, text, cover, mentions, SUPPRESS_EMBEDS, components)
      : await createChannelMessage(env.DISCORD_BOT_TOKEN, channel, text, mentions, SUPPRESS_EMBEDS, components);
    if (made.ok) messageId = made.value.id;
    else console.warn(`announcement: the bot could not post in channel ${channel} (${made.reason}); falling back to the webhook`);
  }
  // The bot could not post there (no token, or no Send Messages in that channel): the webhook, buttons excluded.
  if (!messageId) {
    messageId = cover
      ? await postWebhookWithFile(env.DISCORD_WEBHOOK_URL, text, cover, pingMentions(event.ping))
      : await postWebhook(env.DISCORD_WEBHOOK_URL, text, pingMentions(event.ping), SUPPRESS_EMBEDS);
  }
  if (messageId) await setEventMessageId(db, eventId, messageId);
}

// Bring the text (and buttons) up to date: after an edit, a click, a
// close. A message the bot cannot edit (posted by the webhook before)
// is edited through the webhook instead.
export async function refreshEventAnnouncement(db: D1Database, env: AnnounceEnv, eventId: number, origin: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const event = await getEvent(db, eventId);
  if (!event?.discord_message_id) return;
  const text = announcementText(event, origin);
  if (env.DISCORD_BOT_TOKEN) {
    const channel = await announceChannel(db, env);
    if (channel) {
      const components = announcementComponents(event, await isTicketed(db, eventId), origin);
      // The flags go with every edit: leaving them off turned the link
      // preview back on after the first click changed the counts.
      const edited = await editChannelMessage(env.DISCORD_BOT_TOKEN, channel, event.discord_message_id, text, SUPPRESS_EMBEDS, components);
      if (edited.ok) return;
    }
  }
  await editWebhookMessage(env.DISCORD_WEBHOOK_URL, event.discord_message_id, text);
}

// From a route: the post follows the numbers without holding up the response.
export function refreshAnnouncementInBackground(
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  db: D1Database,
  env: AnnounceEnv,
  eventIds: Iterable<number>,
  origin: string,
): void {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return;
  ctx?.waitUntil((async () => { for (const id of ids) await refreshEventAnnouncement(db, env, id, origin); })().catch(() => {}));
}

// Post it again: the old message goes, a fresh one comes, buttons and all.
export async function repostEventAnnouncement(db: D1Database, env: AnnounceEnv, eventId: number, origin: string): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event || event.published_at === null) return;
  await deleteEventAnnouncement(db, env, event);
  await db.prepare('UPDATE events SET discord_message_id = NULL WHERE id = ?1').bind(eventId).run();
  await postEventAnnouncement(db, env, eventId, origin);
}

export async function deleteEventAnnouncement(db: D1Database, env: AnnounceEnv, event: { discord_message_id: string | null }): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL || !event.discord_message_id) return;
  if (env.DISCORD_BOT_TOKEN) {
    const channel = await announceChannel(db, env);
    if (channel && (await deleteChannelMessage(env.DISCORD_BOT_TOKEN, channel, event.discord_message_id))) return;
  }
  await deleteWebhookMessage(env.DISCORD_WEBHOOK_URL, event.discord_message_id);
}
