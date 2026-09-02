// Discord's server-side API surface: OAuth exchange, guild-member lookup,
// webhook posts and interaction plumbing. The widget's browser-side calls
// live in discord-widget.ts and must stay there — this module never runs in
// the browser.

const API = 'https://discord.com/api/v10';

export const OAUTH_SCOPES = 'identify guilds.members.read';

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', state);
  // No `prompt` param: `none` bounces first-time users straight back with
  // an error before they ever see the consent screen. The default shows
  // the authorize page, a single click for anyone already authorized.
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
  let response: Response;
  try {
    response = await fetch(`${API}/users/@me/guilds/${guildId}/member`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { status: 'error' };
  }
  if (response.status === 404) return { status: 'not_member' };
  if (!response.ok) return { status: 'error' };
  const data = (await response.json()) as { roles?: string[]; nick?: string | null };
  return { status: 'member', roles: data.roles ?? [], nick: data.nick ?? null };
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
export async function postWebhook(webhookUrl: string, content: string): Promise<string | null> {
  try {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) return null;
    const message = (await response.json()) as { id?: string };
    return message.id ?? null;
  } catch {
    return null;
  }
}

// Webhook messages can be deleted through the webhook itself, no bot token
// needed — used when an announcement is deleted on the site.
export async function deleteWebhookMessage(webhookUrl: string, messageId: string): Promise<void> {
  await fetch(`${webhookUrl}/messages/${messageId}`, { method: 'DELETE' }).catch(() => {});
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
): Promise<void> {
  await fetch(`${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(() => {});
}
