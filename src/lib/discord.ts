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
  // Admin writes re-verify on every request, so rapid clicking (recording
  // bracket winners) can trip Discord's per-token rate limit. A 429 is not
  // "Discord is down": wait out the advertised cooldown once and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${API}/users/@me/guilds/${guildId}/member`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch {
      return { status: 'error' };
    }
    if (response.status === 404) return { status: 'not_member' };
    if (response.status === 429 && attempt === 0) {
      const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.min((body.retry_after ?? 1) * 1000, 2500);
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
  allowedMentions?: { parse: string[] },
): Promise<string | null> {
  try {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        allowedMentions ? { content, allowed_mentions: allowedMentions } : { content },
      ),
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
): Promise<void> {
  await fetch(`${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, components }),
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
// per 1000 members. Needs the Server Members intent on the bot.
export async function listGuildMemberRoles(
  botToken: string,
  guildId: string,
): Promise<Map<string, string[]> | null> {
  const roles = new Map<string, string[]>();
  let after = '0';
  for (let page = 0; page < 5; page++) {
    let response: Response;
    try {
      response = await fetch(`${API}/guilds/${guildId}/members?limit=1000&after=${after}`, {
        headers: { authorization: `Bot ${botToken}` },
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const members = (await response.json()) as { user: { id: string }; roles: string[] }[];
    for (const m of members) roles.set(m.user.id, m.roles);
    if (members.length < 1000) break;
    after = members[members.length - 1].user.id;
  }
  return roles;
}

