// A Discord role and a private channel per event, for everyone on the
// roster. The board switches it on from the event page; the bot creates
// both, and from then on every signup gets the role and every departure
// loses it. Who holds the role is remembered in event_role_grants, so a
// signup change costs one Discord call rather than a listing of the whole
// server, and a departure knows whom to strip. "Sync now" on the event
// page repairs any drift.

import type { D1Database } from '@cloudflare/workers-types';
import { DISCORD_GUILD_ID } from './config';
import { getEvent, listSignups, setSetting, type EventRow } from './db';
import {
  createGuildRole,
  createGuildChannel,
  deleteGuildRole,
  deleteChannel,
  renameGuildRole,
  renameChannel,
  fetchBotUserId,
  postChannelMessage,
  setGuildMemberRole,
  PERM_VIEW_CHANNEL,
  PERM_SEND_MESSAGES,
  PERM_READ_HISTORY,
  PERM_MANAGE_CHANNELS,
  type ChannelOverwrite,
  type RoleResult,
} from './discord';
import { formatHelsinkiRange } from './time';

export interface DiscordEnv {
  DISCORD_BOT_TOKEN?: string;
  ADMIN_ROLE_ID: string;
}

// Workers allow a limited number of outgoing requests per invocation, so
// one sync applies at most this many role changes and reports the rest.
export const EVENT_SYNC_LIMIT = 40;

// Discord ids are snowflakes; walk-ins added by hand are "manual-…" and
// have no account to give a role to.
export function isDiscordSnowflake(id: string): boolean {
  return /^\d{5,25}$/.test(id);
}

// Channel names are lowercase ASCII with dashes; ä, ö and friends lose
// their dots, everything else non-alphanumeric becomes a dash.
export function channelSlug(title: string, fallback = 'event'): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, '');
  return slug || fallback;
}

export function roleName(title: string): string {
  return title.trim().slice(0, 100) || 'Event';
}

export function channelUrl(channelId: string): string {
  return `https://discord.com/channels/${DISCORD_GUILD_ID}/${channelId}`;
}

// Everyone on the roster with a real Discord account, going or maybe.
export function participantIds(signups: { discord_id: string }[]): string[] {
  return [...new Set(signups.map((s) => s.discord_id).filter(isDiscordSnowflake))];
}

export interface RoleChange {
  discordId: string;
  on: boolean;
}

// Additions first: someone who just signed up should not wait behind
// housekeeping when a sync is capped.
export function planEventRole(wanted: Iterable<string>, granted: Iterable<string>): RoleChange[] {
  const want = new Set(wanted);
  const have = new Set(granted);
  const changes: RoleChange[] = [];
  for (const id of want) if (!have.has(id)) changes.push({ discordId: id, on: true });
  for (const id of have) if (!want.has(id)) changes.push({ discordId: id, on: false });
  return changes;
}

export async function listGrants(db: D1Database, eventId: number): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT discord_id FROM event_role_grants WHERE event_id = ?1')
    .bind(eventId)
    .all<{ discord_id: string }>();
  return results.map((r) => r.discord_id);
}

export async function countGrants(db: D1Database, eventId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM event_role_grants WHERE event_id = ?1')
    .bind(eventId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type SetRole = (userId: string, on: boolean) => Promise<RoleResult>;

export interface EventSyncSummary {
  added: number;
  removed: number;
  notInServer: number; // signed up, but not (yet) in the Discord server
  forbidden: number; // Discord refused: the bot's role is below the event role, or lacks Manage Roles
  failed: number;
  remaining: number; // beyond this call's cap; another sync picks them up
}

// Bring the event's role in line with its roster. Null when the event has
// no role or the bot is not configured. `setRole` is a parameter only so
// tests can stand in for Discord.
export async function syncEventRole(
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string },
  eventId: number,
  now: number,
  limit = EVENT_SYNC_LIMIT,
  setRole?: SetRole,
): Promise<EventSyncSummary | null> {
  const event = await getEvent(db, eventId);
  if (!event?.discord_role_id || !env.DISCORD_BOT_TOKEN) return null;
  const roleId = event.discord_role_id;
  const token = env.DISCORD_BOT_TOKEN;
  const apply: SetRole = setRole ?? ((userId, on) => setGuildMemberRole(token, DISCORD_GUILD_ID, userId, roleId, on));
  const changes = planEventRole(participantIds(await listSignups(db, eventId)), await listGrants(db, eventId));
  const summary: EventSyncSummary = { added: 0, removed: 0, notInServer: 0, forbidden: 0, failed: 0, remaining: Math.max(0, changes.length - limit) };
  for (const change of changes.slice(0, limit)) {
    const result = await apply(change.discordId, change.on);
    if (change.on) {
      if (result === 'ok') {
        await db
          .prepare('INSERT OR IGNORE INTO event_role_grants (event_id, discord_id, granted_at) VALUES (?1, ?2, ?3)')
          .bind(eventId, change.discordId, now)
          .run();
        summary.added++;
      } else if (result === 'not_in_guild') summary.notInServer++;
      else if (result === 'forbidden') summary.forbidden++;
      else summary.failed++;
    } else if (result === 'ok' || result === 'not_in_guild') {
      await db.prepare('DELETE FROM event_role_grants WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, change.discordId).run();
      summary.removed++;
    } else if (result === 'forbidden') summary.forbidden++;
    else summary.failed++;
  }
  return summary;
}

// After a signup changed: sync without holding up the response. Nothing
// happens for events without a role beyond one cheap lookup each.
export function syncEventRolesInBackground(
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string },
  eventIds: Iterable<number>,
  now: number,
): void {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return;
  const work = (async () => {
    for (const id of ids) await syncEventRole(db, env, id, now);
  })().catch(() => {});
  ctx?.waitUntil(work);
}

// A member erased or banned: every event role they hold goes.
export async function syncMemberEventRoles(
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string },
  discordId: string,
  now: number,
  setRole?: SetRole,
): Promise<void> {
  const { results } = await db
    .prepare('SELECT DISTINCT event_id FROM event_role_grants WHERE discord_id = ?1')
    .bind(discordId)
    .all<{ event_id: number }>();
  for (const row of results) await syncEventRole(db, env, row.event_id, now, EVENT_SYNC_LIMIT, setRole);
}

function boardRoleIds(env: DiscordEnv): string[] {
  return env.ADMIN_ROLE_ID.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '' && id !== '0');
}

export function welcomeMessage(event: Pick<EventRow, 'title' | 'starts_at' | 'ends_at'>, roleId: string, url: string): string {
  return `👋 This channel is for everyone signed up to **${event.title.trim()}** (${formatHelsinkiRange(event.starts_at, event.ends_at)}). The site gives the <@&${roleId}> role to everyone on the roster and takes it away when someone leaves.\n${url}`;
}

export type SetupResult =
  | { ok: true; channelId: string }
  | { ok: false; reason: 'unconfigured' | 'missing' | 'exists' | 'forbidden' | 'error' };

// Create the role and the channel, remember them, and give the role to
// everyone already on the roster. The channel is hidden from @everyone and
// open to the role, the board's roles and the bot itself. A category, when
// chosen, is remembered as the default for the next event.
export async function setUpEventDiscord(
  db: D1Database,
  env: DiscordEnv,
  eventId: number,
  categoryId: string | null,
  origin: string,
  by: string,
  now: number,
): Promise<SetupResult> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { ok: false, reason: 'unconfigured' };
  const event = await getEvent(db, eventId);
  if (!event) return { ok: false, reason: 'missing' };
  if (event.discord_role_id || event.discord_channel_id) return { ok: false, reason: 'exists' };
  const botId = await fetchBotUserId(token);
  if (!botId) return { ok: false, reason: 'error' };
  const reason = `lahtiag.fi event ${eventId}`;
  const url = `${origin}/events/${eventId}`;

  const role = await createGuildRole(token, DISCORD_GUILD_ID, roleName(event.title), reason);
  if (!role.ok) return { ok: false, reason: role.reason };

  const view = PERM_VIEW_CHANNEL.toString();
  const overwrites: ChannelOverwrite[] = [
    { id: DISCORD_GUILD_ID, type: 0, allow: '0', deny: view },
    { id: role.value.id, type: 0, allow: view, deny: '0' },
    { id: botId, type: 1, allow: (PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY | PERM_MANAGE_CHANNELS).toString(), deny: '0' },
    ...boardRoleIds(env).map((id): ChannelOverwrite => ({ id, type: 0, allow: view, deny: '0' })),
  ];
  const channel = await createGuildChannel(
    token,
    DISCORD_GUILD_ID,
    {
      name: channelSlug(event.title, `event-${eventId}`),
      topic: `${event.title.trim()} · ${formatHelsinkiRange(event.starts_at, event.ends_at)} · ${url}`.slice(0, 1024),
      parentId: categoryId,
      overwrites,
    },
    reason,
  );
  if (!channel.ok) {
    await deleteGuildRole(token, DISCORD_GUILD_ID, role.value.id, reason);
    return { ok: false, reason: channel.reason };
  }

  await db
    .prepare('UPDATE events SET discord_role_id = ?2, discord_channel_id = ?3 WHERE id = ?1')
    .bind(eventId, role.value.id, channel.value.id)
    .run();
  if (categoryId) await setSetting(db, 'event_category_id', categoryId, by, now);
  await postChannelMessage(token, channel.value.id, welcomeMessage(event, role.value.id, url));
  await syncEventRole(db, env, eventId, now);
  return { ok: true, channelId: channel.value.id };
}

// Delete the role and the channel in Discord, best effort. True when both
// are gone (or were already).
export async function removeEventDiscordObjects(
  env: { DISCORD_BOT_TOKEN?: string },
  event: Pick<EventRow, 'id' | 'discord_role_id' | 'discord_channel_id'>,
): Promise<boolean> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return !event.discord_role_id && !event.discord_channel_id;
  const reason = `lahtiag.fi event ${event.id}`;
  let ok = true;
  if (event.discord_channel_id && !(await deleteChannel(token, event.discord_channel_id, reason))) ok = false;
  if (event.discord_role_id && !(await deleteGuildRole(token, DISCORD_GUILD_ID, event.discord_role_id, reason))) ok = false;
  return ok;
}

export type TeardownResult = 'ok' | 'partial' | 'nothing';

// The board's "Remove role and channel": Discord first, then the site
// forgets both either way, so a half-deleted pair never blocks a retry
// (the leftover is removed by hand, as the flash says).
export async function tearDownEventDiscord(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number): Promise<TeardownResult> {
  const event = await getEvent(db, eventId);
  if (!event || (!event.discord_role_id && !event.discord_channel_id)) return 'nothing';
  const clean = await removeEventDiscordObjects(env, event);
  await db.batch([
    db.prepare('DELETE FROM event_role_grants WHERE event_id = ?1').bind(eventId),
    db.prepare('UPDATE events SET discord_role_id = NULL, discord_channel_id = NULL WHERE id = ?1').bind(eventId),
  ]);
  return clean ? 'ok' : 'partial';
}

// A retitled event renames its role and channel to match; best effort.
export async function renameEventDiscord(
  env: { DISCORD_BOT_TOKEN?: string },
  event: Pick<EventRow, 'id' | 'title' | 'starts_at' | 'ends_at' | 'discord_role_id' | 'discord_channel_id'>,
  origin: string,
): Promise<void> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;
  if (event.discord_role_id) await renameGuildRole(token, DISCORD_GUILD_ID, event.discord_role_id, roleName(event.title));
  if (event.discord_channel_id) {
    const url = `${origin}/events/${event.id}`;
    await renameChannel(
      token,
      event.discord_channel_id,
      channelSlug(event.title, `event-${event.id}`),
      `${event.title.trim()} · ${formatHelsinkiRange(event.starts_at, event.ends_at)} · ${url}`.slice(0, 1024),
    );
  }
}
