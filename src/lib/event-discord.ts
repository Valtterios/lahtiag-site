// A Discord role and a private channel per event, for everyone on the
// roster. The board switches it on from the event page; the bot creates
// both, and from then on every signup gets the role and every departure
// loses it. Who holds the role is remembered in event_role_grants, so a
// signup change costs one Discord call rather than a listing of the whole
// server, and a departure knows whom to strip. "Sync now" on the event
// page repairs any drift.

import type { D1Database } from '@cloudflare/workers-types';
import { DISCORD_GUILD_ID } from './config';
import { getEvent, listSignups, getSettings, setSetting, getEventCover, type EventRow } from './db';
import {
  createGuildRole,
  createGuildChannel,
  createGuildCategory,
  fetchChannel,
  createScheduledEvent,
  updateScheduledEvent,
  deleteScheduledEvent,
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
  type ScheduledEventInput,
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

export function scheduledEventUrl(eventId: string): string {
  return `https://discord.com/events/${DISCORD_GUILD_ID}/${eventId}`;
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

// Hidden from @everyone; the board and the bot see it.
function privateOverwrites(env: DiscordEnv, botId: string): ChannelOverwrite[] {
  const view = PERM_VIEW_CHANNEL.toString();
  return [
    { id: DISCORD_GUILD_ID, type: 0, allow: '0', deny: view },
    { id: botId, type: 1, allow: (PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY | PERM_MANAGE_CHANNELS).toString(), deny: '0' },
    ...boardRoleIds(env).map((id): ChannelOverwrite => ({ id, type: 0, allow: view, deny: '0' })),
  ];
}

export const EVENT_CATEGORY_NAME = 'Events';

// The category every event channel lives in. The bot creates it the first
// time and remembers it; if someone deletes it in Discord, the next event
// makes a new one. Null when Discord refused, and the channel then goes
// to the top of the list instead.
export async function ensureEventCategory(db: D1Database, env: DiscordEnv, botId: string, by: string, now: number): Promise<string | null> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return null;
  const saved = (await getSettings(db)).event_category_id;
  if (saved) {
    const found = await fetchChannel(token, saved);
    if (found.ok ? found.type === 4 : !found.gone) return saved;
  }
  const created = await createGuildCategory(token, DISCORD_GUILD_ID, EVENT_CATEGORY_NAME, privateOverwrites(env, botId), 'lahtiag.fi event channels');
  if (!created.ok) return null;
  await setSetting(db, 'event_category_id', created.value.id, by, now);
  return created.value.id;
}

export function welcomeMessage(event: Pick<EventRow, 'title' | 'starts_at' | 'ends_at'>, roleId: string, url: string): string {
  return `👋 This channel is for everyone signed up to **${event.title.trim()}** (${formatHelsinkiRange(event.starts_at, event.ends_at)}). The site gives the <@&${roleId}> role to everyone on the roster and takes it away when someone leaves.\n${url}`;
}

export type SetupResult =
  | { ok: true; channelId: string }
  | { ok: false; reason: 'unconfigured' | 'missing' | 'exists' | 'forbidden' | 'error' };

// Create the role and the channel, remember them, and give the role to
// everyone already on the roster. The channel goes under the bot's Events
// category, hidden from @everyone and open to the role, the board's roles
// and the bot itself.
export async function setUpEventDiscord(
  db: D1Database,
  env: DiscordEnv,
  eventId: number,
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

  const categoryId = await ensureEventCategory(db, env, botId, by, now);
  const overwrites: ChannelOverwrite[] = [
    ...privateOverwrites(env, botId),
    { id: role.value.id, type: 0, allow: PERM_VIEW_CHANNEL.toString(), deny: '0' },
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
  await postChannelMessage(token, channel.value.id, welcomeMessage(event, role.value.id, url));
  await syncEventRole(db, env, eventId, now);
  return { ok: true, channelId: channel.value.id };
}

// Delete the role and the channel in Discord, best effort, and the
// scheduled event when asked (the site's delete). True when everything
// asked for is gone (or was already).
export async function removeEventDiscordObjects(
  env: { DISCORD_BOT_TOKEN?: string },
  event: Pick<EventRow, 'id' | 'discord_role_id' | 'discord_channel_id'> & { discord_event_id?: string | null },
  scheduledToo = false,
): Promise<boolean> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return !event.discord_role_id && !event.discord_channel_id;
  const reason = `lahtiag.fi event ${event.id}`;
  let ok = true;
  if (event.discord_channel_id && !(await deleteChannel(token, event.discord_channel_id, reason))) ok = false;
  if (event.discord_role_id && !(await deleteGuildRole(token, DISCORD_GUILD_ID, event.discord_role_id, reason))) ok = false;
  if (scheduledToo && event.discord_event_id && !(await deleteScheduledEvent(token, DISCORD_GUILD_ID, event.discord_event_id, reason))) ok = false;
  return ok;
}

// --- Discord's scheduled events ------------------------------------------------

export const DEFAULT_EVENT_HOURS = 4; // when ours has no end time
const DESCRIPTION_MAX = 1000;

// What Discord shows for the event: the first paragraph of ours, who
// organizes it, and the sign-up link; the place, or the link when there
// is no place yet.
export function scheduledEventFields(
  event: Pick<EventRow, 'id' | 'title' | 'description' | 'starts_at' | 'ends_at' | 'location' | 'organizers'>,
  origin: string,
): ScheduledEventInput {
  const url = `${origin}/events/${event.id}`;
  const tail = `${event.organizers ? `Organized by ${event.organizers.trim()}\n\n` : ''}Sign up: ${url}`;
  const room = DESCRIPTION_MAX - tail.length - 2;
  let blurb = ((event.description ?? '').trim().split(/\n\s*\n/)[0] ?? '').trim();
  if (blurb.length > room) blurb = `${blurb.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return {
    name: roleName(event.title),
    description: blurb ? `${blurb}\n\n${tail}` : tail,
    startIso: new Date(event.starts_at * 1000).toISOString(),
    endIso: new Date((event.ends_at ?? event.starts_at + DEFAULT_EVENT_HOURS * 3600) * 1000).toISOString(),
    location: (event.location?.trim() || url).slice(0, 100),
  };
}

// The cover as a data URI for the Discord event's picture.
async function coverDataUri(db: D1Database, eventId: number): Promise<string | undefined> {
  const cover = await getEventCover(db, eventId);
  if (!cover || cover.bytes.byteLength === 0) return undefined;
  const bytes = new Uint8Array(cover.bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${cover.content_type};base64,${btoa(binary)}`;
}

export type ScheduledSync = 'created' | 'updated' | 'removed' | 'skipped' | 'forbidden' | 'error' | 'unconfigured';

// Keep Discord's scheduled event in step with ours: made when a published,
// upcoming event has none, updated when it has one, removed when ours is
// cancelled or back to a draft. Past or already-running events are left
// alone. The cover goes along on creation; `withImage` sends it on an
// update too (a new cover), other edits skip the upload.
export async function syncScheduledEvent(
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string },
  eventId: number,
  origin: string,
  now: number,
  withImage = false,
): Promise<ScheduledSync> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return 'unconfigured';
  const event = await getEvent(db, eventId);
  if (!event) return 'error';
  const reason = `lahtiag.fi event ${eventId}`;
  const live = event.published_at !== null && event.cancelled_at === null;
  if (!live) {
    if (!event.discord_event_id) return 'skipped';
    if (!(await deleteScheduledEvent(token, DISCORD_GUILD_ID, event.discord_event_id, reason))) return 'error';
    await db.prepare('UPDATE events SET discord_event_id = NULL WHERE id = ?1').bind(eventId).run();
    return 'removed';
  }
  if (event.starts_at <= now) return 'skipped';
  const fields = scheduledEventFields(event, origin);
  if (event.discord_event_id) {
    const image = withImage ? await coverDataUri(db, eventId) : undefined;
    const result = await updateScheduledEvent(token, DISCORD_GUILD_ID, event.discord_event_id, image ? { ...fields, image } : fields);
    if (result.ok) return 'updated';
    if (result.status !== 404) return result.reason;
    // Deleted on Discord's side: make it again.
  }
  const image = await coverDataUri(db, eventId);
  let created = await createScheduledEvent(token, DISCORD_GUILD_ID, image ? { ...fields, image } : fields, reason);
  if (!created.ok && image && created.reason === 'error') created = await createScheduledEvent(token, DISCORD_GUILD_ID, fields, reason);
  if (!created.ok) return created.reason;
  await db.prepare('UPDATE events SET discord_event_id = ?2 WHERE id = ?1').bind(eventId, created.value.id).run();
  return 'created';
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
