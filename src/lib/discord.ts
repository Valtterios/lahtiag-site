// Discord's server-side API surface: OAuth exchange, guild-member lookup,
// webhook posts and interaction plumbing. The widget's browser-side calls
// live in discord-widget.ts and must stay there — this module never runs in
// the browser.

const API = 'https://discord.com/api/v10';

import { formatHelsinkiRange } from './time';

// The one true shape of an event announcement, shared by create (web and
// slash command) and edit so an edited event's message stays consistent.
export function eventAnnouncement(input: {
  title: string;
  startsAt: number;
  endsAt: number | null;
  organizers: string | null;
  teamSize: number | null;
  url: string;
}): string {
  const byLine = input.organizers ? `\nOrganized by ${input.organizers}` : '';
  const teamsLine = input.teamSize ? `\nTeams of ${input.teamSize}, form yours on the site!` : '';
  return `📅 **${input.title.trim()}**\n${formatHelsinkiRange(input.startsAt, input.endsAt)}${byLine}${teamsLine}\nSign up: ${input.url}`;
}

// Heads-up to the board's private channel when someone applies for
// membership. Name and school only: the register page has the rest, and a
// Discord channel is not where personal data should pile up. The name is
// the first unauthenticated text to reach a webhook, so it goes inside an
// inline code span (no markdown, no masked links) with backticks and line
// breaks removed; the caller also sends allowed_mentions so "@everyone" in
// a name pings nobody.
export function applicationNotice(input: { name: string; studentStatus: string; url: string }): string {
  const name = input.name.replace(/[`\r\n]/g, '').trim() || '(no name)';
  return `📝 **New membership application**: \`${name}\` (${input.studentStatus})\nReview: ${input.url}`;
}

// A member asking to link their Discord account to an existing entry, and
// a member turning on "I want to be an active" (the board adds them to the
// Telegram group). Same code-span treatment for user-supplied text.
function codeSpan(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, '').trim() || '(blank)'}\``;
}

export function linkRequestNotice(input: { handle: string; url: string }): string {
  return `🔗 **Link request**: Discord user ${codeSpan(input.handle)} says an entry in the register is theirs.\nConfirm or dismiss: ${input.url}`;
}

export function activeNotice(input: { name: string; telegram: string | null; url: string }): string {
  const tg = input.telegram ? ` (Telegram ${codeSpan(`@${input.telegram}`)})` : ' (no Telegram handle given)';
  return `🙋 **Actives request**: ${codeSpan(input.name)}${tg} wants to be an active. Approve on the register.\nEntry: ${input.url}`;
}

// For messages carrying user-supplied text: Discord resolves no mentions
// at all, whatever the content says.
export const NO_MENTIONS = { parse: [] as string[] };

export const OAUTH_SCOPES = 'identify guilds.members.read';

export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  silent: boolean,
): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', state);
  // Silent first: `prompt=none` signs previously-authorized members in with
  // no Discord UI at all. For someone who never authorized, Discord bounces
  // straight back with an error — the callback detects that and retries via
  // /login?retry=1, which omits the param and shows the consent screen.
  if (silent) url.searchParams.set('prompt', 'none');
  return url.toString();
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const response = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { access_token?: string };
  return data.access_token ?? null;
}

// Best-effort revocation at logout: clearing the cookie signs the browser
// out, but the Discord token sealed inside it would stay live at Discord
// until it expires on its own.
export async function revokeToken(
  clientId: string,
  clientSecret: string,
  accessToken: string,
): Promise<void> {
  await fetch(`${API}/oauth2/token/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token: accessToken,
      token_type_hint: 'access_token',
    }),
  }).catch(() => {});
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export async function fetchMe(accessToken: string): Promise<DiscordUser | null> {
  const response = await fetch(`${API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  return (await response.json()) as DiscordUser;
}

// The three outcomes the spec's error handling distinguishes: in the server,
// not in the server, and "Discord is unreachable" — the latter two require
// different actions from the user and must not be conflated.
export type GuildMembership =
  | { status: 'member'; roles: string[]; nick: string | null }
  | { status: 'not_member' }
  | { status: 'error' };

export async function fetchGuildMember(
  accessToken: string,
  guildId: string,
): Promise<GuildMembership> {
  // Admin writes re-verify (with a short cache), so rapid clicking can
  // still trip Discord's per-token rate limit. A 429 is not "Discord is
  // down": wait out the advertised cooldown, up to twice, and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${API}/users/@me/guilds/${guildId}/member`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch {
      return { status: 'error' };
    }
    if (response.status === 404) return { status: 'not_member' };
    if (response.status === 429 && attempt < 2) {
      const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.min((body.retry_after ?? 1) * 1000, 5000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok) return { status: 'error' };
    const data = (await response.json()) as { roles?: string[]; nick?: string | null };
    return { status: 'member', roles: data.roles ?? [], nick: data.nick ?? null };
  }
  return { status: 'error' };
}

export function hasAdminRole(roles: string[], adminRoleIds: string): boolean {
  // The var holds one role id or a comma-separated list. "0" is the
  // fail-closed placeholder from wrangler.toml [vars]; no real role ever
  // has that id.
  const allowed = adminRoleIds
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '' && id !== '0');
  return allowed.some((id) => roles.includes(id));
}

// Post to the announcements channel webhook. `?wait=true` makes Discord
// return the created message, whose id is stored so a later edit can target
// it instead of posting again (spec, discord_message_id).
export async function postWebhook(
  webhookUrl: string,
  content: string,
  allowedMentions?: { parse: string[]; users?: string[] },
  flags?: number, // SUPPRESS_EMBEDS keeps the link's preview card off
): Promise<string | null> {
  try {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        ...(allowedMentions ? { allowed_mentions: allowedMentions } : {}),
        ...(flags ? { flags } : {}),
      }),
    });
    if (!response.ok) return null;
    const message = (await response.json()) as { id?: string };
    return message.id ?? null;
  } catch {
    return null;
  }
}

// CDN URL for a member's avatar; the index-based default avatar when they
// have none. Both hosts are already in the CSP img-src allowlist.
export function avatarUrl(discordId: string, avatarHash: string | null): string {
  if (avatarHash) {
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=64`;
  }
  // Manually added participants have synthetic non-numeric ids ("manual-…"),
  // where the snowflake math would throw; hash the string instead.
  let index: number;
  try {
    index = Number(BigInt(discordId) >> 22n) % 6;
  } catch {
    index = 0;
    for (const char of discordId) index = (index + char.charCodeAt(0)) % 6;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// Webhook messages can be deleted through the webhook itself, no bot token
// needed — used when an announcement is deleted on the site.
export async function deleteWebhookMessage(webhookUrl: string, messageId: string): Promise<void> {
  await fetch(`${webhookUrl}/messages/${messageId}`, { method: 'DELETE' }).catch(() => {});
}

// ...and edited in place — the whole reason discord_message_id is stored
// (spec): an edited event updates its original announcement instead of
// posting again.
export async function editWebhookMessage(
  webhookUrl: string,
  messageId: string,
  content: string,
): Promise<void> {
  await fetch(`${webhookUrl}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(() => {});
}

// --- HTTP interactions -----------------------------------------------------

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// Ed25519 check of X-Signature-Ed25519 over timestamp+body. Unverified
// requests get 401 without touching anything — that 401 is also how Discord
// validates the endpoint URL when it is first configured.
export async function verifyInteractionSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const publicKey = hexToBytes(publicKeyHex);
  const signature = hexToBytes(signatureHex);
  if (!publicKey || !signature) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', publicKey as unknown as ArrayBuffer, { name: 'Ed25519' }, false, [
      'verify',
    ]);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    'Ed25519',
    key,
    signature as unknown as ArrayBuffer,
    new TextEncoder().encode(timestamp + body),
  );
}

// Edit the deferred reply once the database work is done (spec: acknowledge
// within Discord's 3-second budget first, then edit).
export async function editInteractionReply(
  applicationId: string,
  interactionToken: string,
  content: string,
  components: unknown[] = [],
  embeds: unknown[] = [],
): Promise<void> {
  await fetch(`${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, components, embeds }),
  }).catch(() => {});
}

// --- bot: roles ------------------------------------------------------------------
// The one thing a bot token is needed for (spec relaxed 2026-09-05 with the
// user's go-ahead): giving members the Member and Actives roles. The token
// only ever reaches Discord's API from here. Add and remove are idempotent
// on Discord's side (204 either way), so callers never have to look first.

export type RoleResult = 'ok' | 'not_in_guild' | 'forbidden' | 'error';

export async function setGuildMemberRole(
  botToken: string,
  guildId: string,
  userId: string,
  roleId: string,
  on: boolean,
): Promise<RoleResult> {
  try {
    const response = await fetch(`${API}/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: on ? 'PUT' : 'DELETE',
      headers: { authorization: `Bot ${botToken}`, 'x-audit-log-reason': 'lahtiag.fi member register' },
    });
    if (response.status === 204) return 'ok';
    if (response.status === 404) return 'not_in_guild';
    if (response.status === 403) return 'forbidden';
    return 'error';
  } catch {
    return 'error';
  }
}

// Every member of the server with their roles, for the sync: one request
// per 1000 members. Needs the Server Members intent on the bot; without
// it Discord answers 403, which is reported as such so the page can say
// exactly what to switch on.
export interface GuildMemberInfo {
  roles: string[];
  username: string; // the unique handle
  display: string; // server nick, else global name, else handle
}

export type GuildMembers =
  | { ok: true; roles: Map<string, string[]>; members: Map<string, GuildMemberInfo> }
  | { ok: false; reason: 'intent' | 'error' };

export async function listGuildMemberRoles(botToken: string, guildId: string): Promise<GuildMembers> {
  const roles = new Map<string, string[]>();
  const members = new Map<string, GuildMemberInfo>();
  let after = '0';
  for (let page = 0; page < 5; page++) {
    let response: Response;
    try {
      response = await fetch(`${API}/guilds/${guildId}/members?limit=1000&after=${after}`, {
        headers: { authorization: `Bot ${botToken}` },
      });
    } catch {
      return { ok: false, reason: 'error' };
    }
    if (response.status === 403) return { ok: false, reason: 'intent' };
    if (!response.ok) return { ok: false, reason: 'error' };
    const page_ = (await response.json()) as {
      user: { id: string; username: string; global_name?: string | null };
      nick?: string | null;
      roles: string[];
    }[];
    for (const m of page_) {
      roles.set(m.user.id, m.roles);
      members.set(m.user.id, {
        roles: m.roles,
        username: m.user.username,
        display: m.nick ?? m.user.global_name ?? m.user.username,
      });
    }
    if (page_.length < 1000) break;
    after = page_[page_.length - 1].user.id;
  }
  return { ok: true, roles, members };
}

export interface GuildRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

// The server's roles, for the register's role picker. A 403 means the
// bot is not in the server (or lost its permission); null either way.
export async function listGuildRoles(botToken: string, guildId: string): Promise<GuildRole[] | null> {
  try {
    const response = await fetch(`${API}/guilds/${guildId}/roles`, {
      headers: { authorization: `Bot ${botToken}` },
    });
    if (!response.ok) return null;
    const roles = (await response.json()) as GuildRole[];
    return roles
      .filter((r) => r.id !== guildId) // @everyone shares the guild's id
      .sort((a, b) => b.position - a.position);
  } catch {
    return null;
  }
}


// --- bot: event roles and channels ------------------------------------------
// One role and one private channel per event that asks for them
// (src/lib/event-discord.ts). Needs Manage Roles and Manage Channels on the
// bot's role; a 403 is reported apart so the page can say which is missing.

export type BotResult<T> = { ok: true; value: T } | { ok: false; reason: 'forbidden' | 'error' };

async function botCall<T>(
  botToken: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  reason?: string,
): Promise<BotResult<T> & { status?: number }> {
  try {
    const headers: Record<string, string> = { authorization: `Bot ${botToken}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (reason) headers['x-audit-log-reason'] = reason;
    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      // Into the Worker's logs, so a refusal can be read back (wrangler tail).
      if (response.status !== 404) console.warn(`discord ${method} ${path} -> ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`);
      return { ok: false, reason: response.status === 403 ? 'forbidden' : 'error', status: response.status };
    }
    if (response.status === 204) return { ok: true, value: undefined as T };
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    console.warn(`discord ${method} ${path} failed: ${String(error).slice(0, 200)}`);
    return { ok: false, reason: 'error' };
  }
}

// Permission bits, as the strings Discord's API takes.
export const PERM_VIEW_CHANNEL = 1n << 10n;
export const PERM_SEND_MESSAGES = 1n << 11n;
export const PERM_READ_HISTORY = 1n << 16n;
export const PERM_MANAGE_CHANNELS = 1n << 4n;
export const PERM_CONNECT = 1n << 20n;

export interface ChannelOverwrite {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow: string;
  deny: string;
}

// The bot's own user id, for giving itself a way into the private channel.
export async function fetchBotUserId(botToken: string): Promise<string | null> {
  const result = await botCall<{ id: string }>(botToken, 'GET', '/users/@me');
  return result.ok ? result.value.id : null;
}

export async function createGuildRole(
  botToken: string,
  guildId: string,
  name: string,
  reason: string,
): Promise<BotResult<{ id: string }>> {
  return botCall<{ id: string }>(
    botToken,
    'POST',
    `/guilds/${guildId}/roles`,
    { name, permissions: '0', mentionable: true, hoist: false },
    reason,
  );
}

export async function renameGuildRole(botToken: string, guildId: string, roleId: string, name: string): Promise<void> {
  await botCall(botToken, 'PATCH', `/guilds/${guildId}/roles/${roleId}`, { name });
}

// Deleting something already gone counts as done.
export async function deleteGuildRole(botToken: string, guildId: string, roleId: string, reason: string): Promise<boolean> {
  const result = await botCall(botToken, 'DELETE', `/guilds/${guildId}/roles/${roleId}`, undefined, reason);
  return result.ok || result.status === 404;
}

export interface GuildCategory {
  id: string;
  name: string;
  position: number;
}

// The server's channel categories, for choosing where an event channel goes.
export async function listGuildCategories(botToken: string, guildId: string): Promise<GuildCategory[] | null> {
  const result = await botCall<{ id: string; name: string; type: number; position: number }[]>(botToken, 'GET', `/guilds/${guildId}/channels`);
  if (!result.ok) return null;
  return result.value
    .filter((c) => c.type === 4)
    .map((c) => ({ id: c.id, name: c.name, position: c.position }))
    .sort((a, b) => a.position - b.position);
}

export async function createGuildChannel(
  botToken: string,
  guildId: string,
  input: { name: string; topic?: string; parentId: string | null; overwrites: ChannelOverwrite[]; voice?: boolean },
  reason: string,
): Promise<BotResult<{ id: string }>> {
  // Voice channels take no topic; sending one is a 400.
  return botCall<{ id: string }>(
    botToken,
    'POST',
    `/guilds/${guildId}/channels`,
    {
      name: input.name,
      type: input.voice ? 2 : 0,
      ...(input.voice ? {} : { topic: input.topic ?? '' }),
      parent_id: input.parentId,
      permission_overwrites: input.overwrites,
    },
    reason,
  );
}

// Any channel edit: a move into a category, a new name, new overwrites.
export async function updateChannel(botToken: string, channelId: string, body: Record<string, unknown>): Promise<boolean> {
  return (await botCall(botToken, 'PATCH', `/channels/${channelId}`, body)).ok;
}

export async function renameChannel(botToken: string, channelId: string, name: string, topic: string): Promise<void> {
  await botCall(botToken, 'PATCH', `/channels/${channelId}`, { name, topic });
}

export async function deleteChannel(botToken: string, channelId: string, reason: string): Promise<boolean> {
  const result = await botCall(botToken, 'DELETE', `/channels/${channelId}`, undefined, reason);
  return result.ok || result.status === 404;
}

// Links in the bot's lines don't unfurl: the event page and the bracket
// page would otherwise each drop a preview card under every message.
export const SUPPRESS_EMBEDS = 4;

export async function postChannelMessage(
  botToken: string,
  channelId: string,
  content: string,
  allowedMentions: { parse: string[]; roles?: string[]; users?: string[] } = NO_MENTIONS,
  flags = 0,
): Promise<boolean> {
  const result = await botCall(botToken, 'POST', `/channels/${channelId}/messages`, { content, allowed_mentions: allowedMentions, flags });
  return result.ok;
}

export const PERM_MANAGE_EVENTS = 1n << 33n;

// A category (type 4) for the event channels, with its own overwrites.
export async function createGuildCategory(
  botToken: string,
  guildId: string,
  name: string,
  overwrites: ChannelOverwrite[],
  reason: string,
): Promise<BotResult<{ id: string }>> {
  return botCall<{ id: string }>(botToken, 'POST', `/guilds/${guildId}/channels`, { name, type: 4, permission_overwrites: overwrites }, reason);
}

// Whether a channel still exists: its type, or "gone" for a 404 as
// opposed to Discord not answering.
export async function fetchChannel(botToken: string, channelId: string): Promise<{ ok: true; type: number } | { ok: false; gone: boolean }> {
  const result = await botCall<{ type: number }>(botToken, 'GET', `/channels/${channelId}`);
  if (result.ok) return { ok: true, type: result.value.type };
  return { ok: false, gone: result.status === 404 };
}

// --- bot: scheduled events -------------------------------------------------------
// Discord's own event listing ("Events" at the top of the channel list),
// external type: a place and a time, RSVPs on Discord's side.

export interface ScheduledEventInput {
  name: string;
  description: string;
  startIso: string;
  endIso: string;
  location: string;
  image?: string; // data URI
}

function scheduledEventBody(input: ScheduledEventInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    scheduled_start_time: input.startIso,
    scheduled_end_time: input.endIso,
    privacy_level: 2,
    entity_type: 3,
    entity_metadata: { location: input.location },
    ...(input.image ? { image: input.image } : {}),
  };
}

export async function createScheduledEvent(
  botToken: string,
  guildId: string,
  input: ScheduledEventInput,
  reason: string,
): Promise<BotResult<{ id: string }>> {
  return botCall<{ id: string }>(botToken, 'POST', `/guilds/${guildId}/scheduled-events`, scheduledEventBody(input), reason);
}

export async function updateScheduledEvent(
  botToken: string,
  guildId: string,
  eventId: string,
  input: ScheduledEventInput,
): Promise<BotResult<unknown> & { status?: number }> {
  return botCall(botToken, 'PATCH', `/guilds/${guildId}/scheduled-events/${eventId}`, scheduledEventBody(input));
}

// Who pressed Interested on the scheduled event; null when Discord did
// not answer. Pages of 100, a handful at most.
export async function listScheduledEventUsers(botToken: string, guildId: string, eventId: string): Promise<string[] | null> {
  const ids: string[] = [];
  let after = '0';
  for (let page = 0; page < 10; page++) {
    const result = await botCall<{ user: { id: string } }[]>(botToken, 'GET', `/guilds/${guildId}/scheduled-events/${eventId}/users?limit=100&after=${after}`);
    if (!result.ok) return page === 0 ? null : ids;
    for (const row of result.value) ids.push(row.user.id);
    if (result.value.length < 100) break;
    after = result.value[result.value.length - 1].user.id;
  }
  return ids;
}

export async function deleteScheduledEvent(botToken: string, guildId: string, eventId: string, reason: string): Promise<boolean> {
  const result = await botCall(botToken, 'DELETE', `/guilds/${guildId}/scheduled-events/${eventId}`, undefined, reason);
  return result.ok || result.status === 404;
}

// --- bot: messages the bot keeps editing --------------------------------------
// The live bracket: posted once, pinned, then edited after every result.

export async function createChannelMessage(
  botToken: string,
  channelId: string,
  content: string,
  allowedMentions: { parse: string[]; roles?: string[] } = NO_MENTIONS,
  flags = 0,
  components: unknown[] = [],
): Promise<BotResult<{ id: string }>> {
  return botCall<{ id: string }>(botToken, 'POST', `/channels/${channelId}/messages`, { content, allowed_mentions: allowedMentions, flags, components });
}

export async function editChannelMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  content: string,
  flags = 0,
  components?: unknown[],
): Promise<BotResult<unknown> & { status?: number }> {
  return botCall(botToken, 'PATCH', `/channels/${channelId}/messages/${messageId}`, { content, allowed_mentions: NO_MENTIONS, flags, ...(components ? { components } : {}) });
}

// The channel behind a webhook URL, from Discord's own record of it.
export async function fetchWebhookChannel(webhookUrl: string): Promise<string | null> {
  try {
    const response = await fetch(webhookUrl);
    if (!response.ok) return null;
    const data = (await response.json()) as { channel_id?: string };
    return data.channel_id ?? null;
  } catch {
    return null;
  }
}

export async function deleteChannelMessage(botToken: string, channelId: string, messageId: string): Promise<boolean> {
  const result = await botCall(botToken, 'DELETE', `/channels/${channelId}/messages/${messageId}`);
  return result.ok || result.status === 404;
}

// Needs Pin Messages (split out of Manage Messages). Discord moved the
// endpoint in 2025; both paths are tried, whichever way the server answers.
export async function pinChannelMessage(botToken: string, channelId: string, messageId: string): Promise<boolean> {
  const fresh = await botCall(botToken, 'PUT', `/channels/${channelId}/messages/pins/${messageId}`, undefined, 'lahtiag.fi live bracket');
  if (fresh.ok) return true;
  return (await botCall(botToken, 'PUT', `/channels/${channelId}/pins/${messageId}`, undefined, 'lahtiag.fi live bracket')).ok;
}

// Whether a message is pinned; null when it cannot be read.
export async function isMessagePinned(botToken: string, channelId: string, messageId: string): Promise<boolean | null> {
  const result = await botCall<{ pinned?: boolean }>(botToken, 'GET', `/channels/${channelId}/messages/${messageId}`);
  return result.ok ? result.value.pinned === true : null;
}

export const PERM_MANAGE_MESSAGES = 1n << 13n;
export const PERM_PIN_MESSAGES = 1n << 51n; // pinning moved out of Manage Messages

// --- bot: messages with a picture --------------------------------------------------
// Multipart uploads: the JSON payload plus one file. On an edit the
// listed attachments replace the old ones, so the picture is swapped.

export interface MessageFile {
  name: string;
  bytes: Uint8Array;
  type: string;
}

async function botUpload(
  botToken: string,
  method: 'POST' | 'PATCH',
  path: string,
  payload: Record<string, unknown>,
  file: MessageFile | MessageFile[],
): Promise<BotResult<{ id: string }> & { status?: number }> {
  try {
    const files = Array.isArray(file) ? file : [file];
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes as BlobPart], { type: f.type }), f.name));
    const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bot ${botToken}` }, body: form });
    if (!response.ok) {
      if (response.status !== 404) console.warn(`discord ${method} ${path} (upload) -> ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`);
      return { ok: false, reason: response.status === 403 ? 'forbidden' : 'error', status: response.status };
    }
    return { ok: true, value: (await response.json()) as { id: string } };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

export async function createChannelMessageWithFile(
  botToken: string,
  channelId: string,
  content: string,
  file: MessageFile | MessageFile[], // up to ten pictures on one message
  allowedMentions: { parse: string[]; roles?: string[]; users?: string[] } = NO_MENTIONS,
  flags = 0,
  components: unknown[] = [],
): Promise<BotResult<{ id: string }>> {
  return botUpload(botToken, 'POST', `/channels/${channelId}/messages`, { content, allowed_mentions: allowedMentions, flags, components }, file);
}

export async function editChannelMessageWithFile(
  botToken: string,
  channelId: string,
  messageId: string,
  content: string,
  file: MessageFile,
  flags = 0,
): Promise<BotResult<{ id: string }> & { status?: number }> {
  return botUpload(botToken, 'PATCH', `/channels/${channelId}/messages/${messageId}`, { content, allowed_mentions: NO_MENTIONS, flags }, file);
}

// --- webhook messages with a picture --------------------------------------------
// The announcement carries the event's cover as an attachment; the link's
// own preview card is switched off so the picture shows once.

export async function postWebhookWithFile(
  webhookUrl: string,
  content: string,
  file: MessageFile | MessageFile[],
  allowedMentions: { parse: string[]; roles?: string[]; users?: string[] } = NO_MENTIONS,
  flags = SUPPRESS_EMBEDS,
): Promise<string | null> {
  try {
    const files = Array.isArray(file) ? file : [file];
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content, allowed_mentions: allowedMentions, flags, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes as BlobPart], { type: f.type }), f.name));
    const response = await fetch(`${webhookUrl}?wait=true`, { method: 'POST', body: form });
    if (!response.ok) return null;
    const message = (await response.json()) as { id?: string };
    return message.id ?? null;
  } catch {
    return null;
  }
}

// Swap the picture on an announcement (a new cover); the text stays.
export async function editWebhookMessageFile(webhookUrl: string, messageId: string, file: MessageFile): Promise<boolean> {
  try {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ attachments: [{ id: 0, filename: file.name }], flags: SUPPRESS_EMBEDS }));
    form.append('files[0]', new Blob([file.bytes as BlobPart], { type: file.type }), file.name);
    const response = await fetch(`${webhookUrl}/messages/${messageId}`, { method: 'PATCH', body: form });
    return response.ok;
  } catch {
    return false;
  }
}

// Edit the deferred reply with a picture attached (the /profile card).
export async function editInteractionReplyWithFile(
  applicationId: string,
  interactionToken: string,
  content: string,
  file: MessageFile,
): Promise<boolean> {
  try {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content, allowed_mentions: NO_MENTIONS, attachments: [{ id: 0, filename: file.name }] }));
    form.append('files[0]', new Blob([file.bytes as BlobPart], { type: file.type }), file.name);
    const response = await fetch(`${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, { method: 'PATCH', body: form });
    return response.ok;
  } catch {
    return false;
  }
}

// A private message from the bot. Fails quietly when the person has DMs
// from server members switched off; callers fall back to a mention.
export async function dmUser(botToken: string, userId: string, content: string): Promise<boolean> {
  const channel = await botCall<{ id: string }>(botToken, 'POST', '/users/@me/channels', { recipient_id: userId });
  if (!channel.ok) return false;
  return (await botCall(botToken, 'POST', `/channels/${channel.value.id}/messages`, { content, allowed_mentions: NO_MENTIONS, flags: SUPPRESS_EMBEDS })).ok;
}
