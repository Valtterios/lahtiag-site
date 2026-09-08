// A Discord role and a private channel per event, for everyone on the
// roster. The board switches it on from the event page; the bot creates
// both, and from then on every signup gets the role and every departure
// loses it. Who holds the role is remembered in event_role_grants, so a
// signup change costs one Discord call rather than a listing of the whole
// server, and a departure knows whom to strip. "Sync now" on the event
// page repairs any drift.

import type { D1Database } from '@cloudflare/workers-types';
import { DISCORD_GUILD_ID } from './config';
import { getEvent, listSignups, listEventTeams, getSettings, setSetting, getEventCover, replaceDiscordInterest, type EventRow, type EventTeamRow } from './db';
import {
  createGuildRole,
  createGuildChannel,
  createGuildCategory,
  fetchChannel,
  createScheduledEvent,
  updateScheduledEvent,
  deleteScheduledEvent,
  listScheduledEventUsers,
  deleteGuildRole,
  deleteChannel,
  renameGuildRole,
  renameChannel,
  updateChannel,
  fetchBotUserId,
  postChannelMessage,
  setGuildMemberRole,
  PERM_VIEW_CHANNEL,
  PERM_SEND_MESSAGES,
  PERM_READ_HISTORY,
  PERM_MANAGE_CHANNELS,
  PERM_CONNECT,
  type ChannelOverwrite,
  type ScheduledEventInput,
  type MessageFile,
  type RoleResult,
} from './discord';
import { formatHelsinkiRange } from './time';
import { dropEventLiveBrackets, refreshEventBrackets } from './event-channel';

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

// Hidden from @everyone; the board and the bot see it (and the board may
// post and speak everywhere, the rules channel included).
function privateOverwrites(env: DiscordEnv, botId: string): ChannelOverwrite[] {
  const view = PERM_VIEW_CHANNEL.toString();
  const board = (PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY | PERM_CONNECT).toString();
  return [
    { id: DISCORD_GUILD_ID, type: 0, allow: '0', deny: view },
    { id: botId, type: 1, allow: (PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY | PERM_MANAGE_CHANNELS).toString(), deny: '0' },
    ...boardRoleIds(env).map((id): ChannelOverwrite => ({ id, type: 0, allow: board, deny: '0' })),
  ];
}

// What the event's role may do in one of its channels.
function roleOverwrite(roleId: string, options: { voice?: boolean; readOnly?: boolean } = {}): ChannelOverwrite {
  const allow = options.voice ? PERM_VIEW_CHANNEL | PERM_CONNECT : PERM_VIEW_CHANNEL;
  return { id: roleId, type: 0, allow: allow.toString(), deny: options.readOnly ? PERM_SEND_MESSAGES.toString() : '0' };
}

export const EVENT_CATEGORY_NAME = 'Events';

// The category every one-channel event lives in. The bot creates it the
// first time and remembers it; if someone deletes it in Discord, the next
// event makes a new one. Null when Discord refused, and the channel then
// goes to the top of the list instead.
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

// --- the channels the bot made for an event ------------------------------------

export type ChannelKind = 'discussion' | 'rules' | 'bracket' | 'teams' | 'commentators' | 'interviews' | 'team';

export interface EventChannelRow {
  event_id: number;
  channel_id: string;
  kind: ChannelKind;
  event_team_id: number | null;
  created_at: number;
}

// A big event's set, in the order they appear. Rules is read-only for
// participants (the board posts there); bracket is the bot's alone, for
// the pinned live bracket, so nobody else can write in it.
export const BIG_EVENT_CHANNELS: { kind: ChannelKind; name: string; voice: boolean; readOnly: boolean; botOnly?: boolean }[] = [
  { kind: 'rules', name: 'rules', voice: false, readOnly: true },
  { kind: 'bracket', name: 'bracket', voice: false, readOnly: true, botOnly: true },
  { kind: 'teams', name: 'teams', voice: false, readOnly: false },
  { kind: 'discussion', name: 'discussion', voice: false, readOnly: false },
  { kind: 'commentators', name: 'Commentators', voice: true, readOnly: false },
  { kind: 'interviews', name: 'Interviews', voice: true, readOnly: false },
];

export async function listEventChannels(db: D1Database, eventId: number): Promise<EventChannelRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM event_discord_channels WHERE event_id = ?1 ORDER BY created_at, channel_id')
    .bind(eventId)
    .all<EventChannelRow>();
  return results;
}

export async function recordEventChannel(db: D1Database, eventId: number, channelId: string, kind: ChannelKind, teamId: number | null, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO event_discord_channels (event_id, channel_id, kind, event_team_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(eventId, channelId, kind, teamId, now)
    .run();
}

function channelTopic(event: Pick<EventRow, 'title' | 'starts_at' | 'ends_at'>, url: string, kind: ChannelKind): string {
  const head = `${event.title.trim()} · ${formatHelsinkiRange(event.starts_at, event.ends_at)}`;
  const what =
    kind === 'rules' ? 'The rules, from the board' : kind === 'bracket' ? 'The live bracket, kept by the bot' : kind === 'teams' ? 'Team talk and team finding' : '';
  return `${head}${what ? ` · ${what}` : ''} · ${url}`.slice(0, 1024);
}

// Make the big set inside the event's category, skipping kinds that
// already exist (the upgrade keeps its channel as discussion). Each one is
// recorded as it is made, so a failure halfway leaves nothing unknown for
// the cleanup. Null when Discord refused; the reason says why.
async function createChannelSet(
  db: D1Database,
  env: DiscordEnv,
  botId: string,
  event: Pick<EventRow, 'id' | 'title' | 'starts_at' | 'ends_at'>,
  roleId: string,
  categoryId: string,
  skip: Set<ChannelKind>,
  url: string,
  now: number,
): Promise<{ ok: true; discussionId: string | null } | { ok: false; reason: 'forbidden' | 'error' }> {
  const token = env.DISCORD_BOT_TOKEN!;
  const reason = `lahtiag.fi event ${event.id}`;
  let discussionId: string | null = null;
  for (const spec of BIG_EVENT_CHANNELS) {
    if (skip.has(spec.kind)) continue;
    const made = await createGuildChannel(
      token,
      DISCORD_GUILD_ID,
      {
        name: spec.name,
        topic: spec.voice ? undefined : channelTopic(event, url, spec.kind),
        parentId: categoryId,
        overwrites: [
          // A bot-only channel takes Send Messages away from the board too.
          ...privateOverwrites(env, botId).map((o) =>
            spec.botOnly && o.type === 0 && o.id !== DISCORD_GUILD_ID ? { ...o, allow: (PERM_VIEW_CHANNEL | PERM_READ_HISTORY).toString() } : o,
          ),
          roleOverwrite(roleId, { voice: spec.voice, readOnly: spec.readOnly }),
        ],
        voice: spec.voice,
      },
      reason,
    );
    if (!made.ok) return { ok: false, reason: made.reason };
    await recordEventChannel(db, event.id, made.value.id, spec.kind, null, now);
    if (spec.kind === 'discussion') discussionId = made.value.id;
  }
  return { ok: true, discussionId };
}

export function welcomeMessage(event: Pick<EventRow, 'title' | 'starts_at' | 'ends_at'>, roleId: string, url: string): string {
  return `👋 This channel is for everyone signed up to **${event.title.trim()}** (${formatHelsinkiRange(event.starts_at, event.ends_at)}). The site gives the <@&${roleId}> role to everyone on the roster and takes it away when someone leaves.\n${url}`;
}

export type EventDiscordSize = 'channel' | 'category';

export type SetupResult =
  | { ok: true; channelId: string | null }
  | { ok: false; reason: 'unconfigured' | 'missing' | 'exists' | 'forbidden' | 'error' };

// Create the role and, by size, either one text channel under the shared
// Events category or the event's own category with the full set; remember
// them, welcome in the discussion channel, and give the role to everyone
// already on the roster. A failure halfway deletes what was made.
export async function setUpEventDiscord(
  db: D1Database,
  env: DiscordEnv,
  eventId: number,
  origin: string,
  by: string,
  now: number,
  size: EventDiscordSize = 'channel',
): Promise<SetupResult> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { ok: false, reason: 'unconfigured' };
  const event = await getEvent(db, eventId);
  if (!event) return { ok: false, reason: 'missing' };
  if (event.discord_role_id || event.discord_channel_id || event.discord_category_id) return { ok: false, reason: 'exists' };
  const botId = await fetchBotUserId(token);
  if (!botId) return { ok: false, reason: 'error' };
  const reason = `lahtiag.fi event ${eventId}`;
  const url = `${origin}/events/${eventId}`;

  const role = await createGuildRole(token, DISCORD_GUILD_ID, roleName(event.title), reason);
  if (!role.ok) return { ok: false, reason: role.reason };
  const roleId = role.value.id;

  let categoryId: string | null = null;
  let channelId: string | null = null;
  let failure: 'forbidden' | 'error' | null = null;
  if (size === 'category') {
    const category = await createGuildCategory(
      token,
      DISCORD_GUILD_ID,
      roleName(event.title),
      [...privateOverwrites(env, botId), roleOverwrite(roleId)],
      reason,
    );
    if (category.ok) {
      categoryId = category.value.id;
      const made = await createChannelSet(db, env, botId, event, roleId, categoryId, new Set(), url, now);
      if (made.ok) channelId = made.discussionId;
      else failure = made.reason;
    } else failure = category.reason;
  } else {
    const shared = await ensureEventCategory(db, env, botId, by, now);
    const channel = await createGuildChannel(
      token,
      DISCORD_GUILD_ID,
      {
        name: channelSlug(event.title, `event-${eventId}`),
        topic: channelTopic(event, url, 'discussion'),
        parentId: shared,
        overwrites: [...privateOverwrites(env, botId), roleOverwrite(roleId)],
      },
      reason,
    );
    if (channel.ok) {
      channelId = channel.value.id;
      await recordEventChannel(db, eventId, channelId, 'discussion', null, now);
    } else failure = channel.reason;
  }
  if (failure) {
    await deleteDiscordObjects(env, { id: eventId, discord_role_id: roleId, discord_channel_id: null, discord_category_id: categoryId }, await listEventChannels(db, eventId));
    await db.prepare('DELETE FROM event_discord_channels WHERE event_id = ?1').bind(eventId).run();
    return { ok: false, reason: failure };
  }

  await db
    .prepare('UPDATE events SET discord_role_id = ?2, discord_channel_id = ?3, discord_category_id = ?4 WHERE id = ?1')
    .bind(eventId, roleId, channelId, categoryId)
    .run();
  if (channelId) await postChannelMessage(token, channelId, welcomeMessage(event, roleId, url));
  await syncEventRole(db, env, eventId, now);
  if (categoryId) await createTeamVoiceChannels(db, env, eventId, now);
  return { ok: true, channelId };
}

export type UpgradeResult = 'ok' | 'unconfigured' | 'missing' | 'exists' | 'forbidden' | 'error';

// A one-channel event that grew: its own category, the channel moved in
// as discussion, and the rest of the set beside it.
export async function upgradeEventDiscord(db: D1Database, env: DiscordEnv, eventId: number, origin: string, now: number): Promise<UpgradeResult> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return 'unconfigured';
  const event = await getEvent(db, eventId);
  if (!event?.discord_role_id || !event.discord_channel_id) return 'missing';
  if (event.discord_category_id) return 'exists';
  const botId = await fetchBotUserId(token);
  if (!botId) return 'error';
  const reason = `lahtiag.fi event ${eventId}`;
  const url = `${origin}/events/${eventId}`;
  const category = await createGuildCategory(token, DISCORD_GUILD_ID, roleName(event.title), [...privateOverwrites(env, botId), roleOverwrite(event.discord_role_id)], reason);
  if (!category.ok) return category.reason;
  await updateChannel(token, event.discord_channel_id, { parent_id: category.value.id, name: 'discussion' });
  await recordEventChannel(db, eventId, event.discord_channel_id, 'discussion', null, now);
  await db.prepare('UPDATE events SET discord_category_id = ?2 WHERE id = ?1').bind(eventId, category.value.id).run();
  const made = await createChannelSet(db, env, botId, event, event.discord_role_id, category.value.id, new Set(['discussion']), url, now);
  if (made.ok) {
    await createTeamVoiceChannels(db, env, eventId, now);
    // Live brackets pinned in discussion move to the new bracket channel.
    await dropEventLiveBrackets(db, env, eventId);
    await refreshEventBrackets(db, env, eventId, origin, now);
  }
  return made.ok ? 'ok' : made.reason;
}

// Which teams still need a voice channel, and which channels belong to a
// team that is gone.
export function planTeamChannels<T extends { id: number }, C extends { event_team_id: number | null }>(teams: T[], channels: C[]): { create: T[]; remove: C[] } {
  const have = new Set(channels.map((c) => c.event_team_id));
  const teamIds = new Set(teams.map((t) => t.id));
  return {
    create: teams.filter((t) => !have.has(t.id)),
    remove: channels.filter((c) => c.event_team_id !== null && !teamIds.has(c.event_team_id)),
  };
}

export type TeamVoiceResult =
  | { ok: true; created: number; removed: number; teams: number }
  | { ok: false; reason: 'unconfigured' | 'needs_category' | 'no_teams' | 'forbidden' | 'error' };

// A voice channel per team, named after it, in the event's own category.
// Runs after every team change (and on request): new teams get theirs,
// disbanded teams lose theirs. Names are not followed (teams don't
// rename). Cheap for events without an own category: one lookup.
export async function createTeamVoiceChannels(db: D1Database, env: DiscordEnv, eventId: number, now: number): Promise<TeamVoiceResult> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { ok: false, reason: 'unconfigured' };
  const event = await getEvent(db, eventId);
  if (!event?.discord_role_id || !event.discord_category_id) return { ok: false, reason: 'needs_category' };
  const teams: EventTeamRow[] = await listEventTeams(db, eventId);
  const existing = (await listEventChannels(db, eventId)).filter((c) => c.kind === 'team');
  if (teams.length === 0 && existing.length === 0) return { ok: false, reason: 'no_teams' };
  const botId = await fetchBotUserId(token);
  if (!botId) return { ok: false, reason: 'error' };
  const reason = `lahtiag.fi event ${eventId}`;
  const plan = planTeamChannels(teams, existing);
  let removed = 0;
  for (const row of plan.remove) {
    if (!(await deleteChannel(token, row.channel_id, reason))) continue;
    await db.prepare('DELETE FROM event_discord_channels WHERE event_id = ?1 AND channel_id = ?2').bind(eventId, row.channel_id).run();
    removed++;
  }
  let created = 0;
  for (const team of plan.create) {
    const made = await createGuildChannel(
      token,
      DISCORD_GUILD_ID,
      {
        name: team.name.trim().slice(0, 100) || `team-${team.id}`,
        parentId: event.discord_category_id,
        overwrites: [...privateOverwrites(env, botId), roleOverwrite(event.discord_role_id, { voice: true })],
        voice: true,
      },
      reason,
    );
    if (!made.ok) return created > 0 || removed > 0 ? { ok: true, created, removed, teams: teams.length } : { ok: false, reason: made.reason };
    await recordEventChannel(db, eventId, made.value.id, 'team', team.id, now);
    created++;
  }
  return { ok: true, created, removed, teams: teams.length };
}

// After teams changed: follow them without holding up the response.
export function syncTeamVoiceChannelsInBackground(
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  db: D1Database,
  env: DiscordEnv,
  eventId: number,
  now: number,
): void {
  ctx?.waitUntil(createTeamVoiceChannels(db, env, eventId, now).catch(() => {}));
}

// A renamed team's voice channel follows, best effort.
export async function renameTeamVoiceChannel(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number, teamId: number, name: string): Promise<void> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;
  const row = await db
    .prepare("SELECT channel_id FROM event_discord_channels WHERE event_id = ?1 AND kind = 'team' AND event_team_id = ?2")
    .bind(eventId, teamId)
    .first<{ channel_id: string }>();
  if (row) await updateChannel(token, row.channel_id, { name: name.trim().slice(0, 100) || `team-${teamId}` });
}

// Delete in Discord everything the bot made for the event: the recorded
// channels, the lone channel of an older event, the category, the role,
// and the scheduled event when asked (the site's delete). Best effort;
// true when all of it is gone (or was already).
export async function deleteDiscordObjects(
  env: { DISCORD_BOT_TOKEN?: string },
  event: Pick<EventRow, 'id' | 'discord_role_id' | 'discord_channel_id' | 'discord_category_id'> & { discord_event_id?: string | null },
  channels: Pick<EventChannelRow, 'channel_id'>[],
  scheduledToo = false,
): Promise<boolean> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return !event.discord_role_id && !event.discord_channel_id && !event.discord_category_id && channels.length === 0;
  const reason = `lahtiag.fi event ${event.id}`;
  let ok = true;
  const ids = new Set(channels.map((c) => c.channel_id));
  if (event.discord_channel_id) ids.add(event.discord_channel_id);
  for (const id of ids) if (!(await deleteChannel(token, id, reason))) ok = false;
  if (event.discord_category_id && !(await deleteChannel(token, event.discord_category_id, reason))) ok = false;
  if (event.discord_role_id && !(await deleteGuildRole(token, DISCORD_GUILD_ID, event.discord_role_id, reason))) ok = false;
  if (scheduledToo && event.discord_event_id && !(await deleteScheduledEvent(token, DISCORD_GUILD_ID, event.discord_event_id, reason))) ok = false;
  return ok;
}

export type TeardownResult = 'ok' | 'partial' | 'nothing';

// The board's "Delete everything" (or "Remove role and channel" on a
// one-channel event): Discord first, then the site forgets it all either
// way, so a half-deleted set never blocks a retry (the leftover is removed
// by hand, as the flash says).
export async function tearDownEventDiscord(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number): Promise<TeardownResult> {
  const event = await getEvent(db, eventId);
  if (!event || (!event.discord_role_id && !event.discord_channel_id && !event.discord_category_id)) return 'nothing';
  const clean = await deleteDiscordObjects(env, event, await listEventChannels(db, eventId));
  await db.batch([
    db.prepare('DELETE FROM event_role_grants WHERE event_id = ?1').bind(eventId),
    db.prepare('DELETE FROM event_discord_channels WHERE event_id = ?1').bind(eventId),
    db.prepare('UPDATE events SET discord_role_id = NULL, discord_channel_id = NULL, discord_category_id = NULL WHERE id = ?1').bind(eventId),
  ]);
  return clean ? 'ok' : 'partial';
}

// Archive a big event: the role goes, so participants lose access and the
// grants are forgotten; the category and its channels stay for the board.
export async function archiveEventDiscord(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number): Promise<TeardownResult> {
  const event = await getEvent(db, eventId);
  if (!event?.discord_role_id) return 'nothing';
  const token = env.DISCORD_BOT_TOKEN;
  const clean = token ? await deleteGuildRole(token, DISCORD_GUILD_ID, event.discord_role_id, `lahtiag.fi event ${eventId} archived`) : false;
  await db.batch([
    db.prepare('DELETE FROM event_role_grants WHERE event_id = ?1').bind(eventId),
    db.prepare('UPDATE events SET discord_role_id = NULL WHERE id = ?1').bind(eventId),
  ]);
  return clean ? 'ok' : 'partial';
}

// A retitled event renames its role and its category, or its lone
// channel, to match; best effort.
export async function renameEventDiscord(
  env: { DISCORD_BOT_TOKEN?: string },
  event: Pick<EventRow, 'id' | 'title' | 'starts_at' | 'ends_at' | 'discord_role_id' | 'discord_channel_id' | 'discord_category_id'>,
  origin: string,
): Promise<void> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;
  if (event.discord_role_id) await renameGuildRole(token, DISCORD_GUILD_ID, event.discord_role_id, roleName(event.title));
  if (event.discord_category_id) {
    await updateChannel(token, event.discord_category_id, { name: roleName(event.title) });
  } else if (event.discord_channel_id) {
    const url = `${origin}/events/${event.id}`;
    await renameChannel(token, event.discord_channel_id, channelSlug(event.title, `event-${event.id}`), channelTopic(event, url, 'discussion'));
  }
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

// The cover as a file to attach (the announcement).
export async function coverFile(db: D1Database, eventId: number): Promise<MessageFile | null> {
  const cover = await getEventCover(db, eventId);
  if (!cover || cover.bytes.byteLength === 0) return null;
  const ext = cover.content_type === 'image/png' ? 'png' : cover.content_type === 'image/webp' ? 'webp' : 'jpg';
  return { name: `cover.${ext}`, bytes: new Uint8Array(cover.bytes), type: cover.content_type };
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

export const INTEREST_SYNC_SECONDS = 120;

// Read Discord's Interested list into the event's interest rows.
export async function syncInterest(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, event: Pick<EventRow, 'id' | 'discord_event_id'>, now: number): Promise<boolean> {
  if (!env.DISCORD_BOT_TOKEN || !event.discord_event_id) return false;
  const ids = await listScheduledEventUsers(env.DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, event.discord_event_id);
  if (ids === null) return false;
  await replaceDiscordInterest(db, event.id, ids, now);
  return true;
}

// From a page view: refresh in the background when the last read is old,
// so the page never waits for Discord.
export function syncInterestInBackground(
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string },
  event: Pick<EventRow, 'id' | 'discord_event_id' | 'interest_synced_at' | 'starts_at'>,
  now: number,
): void {
  if (!event.discord_event_id || event.starts_at < now) return;
  if (event.interest_synced_at !== null && now - event.interest_synced_at < INTEREST_SYNC_SECONDS) return;
  ctx?.waitUntil(syncInterest(db, env, event, now).catch(() => {}));
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
