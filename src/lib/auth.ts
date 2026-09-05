// Stateless sessions (spec, Authentication): an AES-GCM encrypted cookie,
// no server-side store. The payload carries the user's Discord access token
// because admin writes must re-verify the role against Discord (the
// demoted-admin case) and, with no session store and no bot token in the
// design, the user's own token is the only credential available later.
// Encrypted rather than sign-only so that token is unreadable to anyone who
// obtains the cookie value without SESSION_SECRET; GCM's built-in auth tag
// is the tamper check.

export interface Session {
  discordId: string;
  username: string; // display name: server nick, else global name, else handle
  handle?: string; // the unique @handle; absent on cookies from before it was stored
  avatarHash: string | null;
  isAdmin: boolean;
  accessToken: string;
  expiresAt: number; // unix seconds
}

export const SESSION_COOKIE = '__Host-session';
export const CSRF_COOKIE = '__Host-csrf';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array | null {
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// SESSION_SECRET is an arbitrary string; SHA-256 turns it into exactly the
// 32 bytes AES-256 wants.
async function sessionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sealSession(session: Session, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await sessionKey(secret),
    new TextEncoder().encode(JSON.stringify(session)),
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

// Authenticated decryption first, then expiry: a tampered token never gets
// its payload parsed. Any malformed or foreign input (including cookies
// from the pre-encryption format) returns null — signed out, not an error.
export async function openSession(
  token: string,
  secret: string,
  now: number,
): Promise<Session | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const iv = b64urlDecode(token.slice(0, dot));
  const ciphertext = b64urlDecode(token.slice(dot + 1));
  if (!iv || iv.length !== 12 || !ciphertext || ciphertext.length === 0) return null;
  let payload: ArrayBuffer;
  try {
    payload = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
      await sessionKey(secret),
      ciphertext as unknown as ArrayBuffer,
    );
  } catch {
    return null;
  }
  let session: Session;
  try {
    session = JSON.parse(new TextDecoder().decode(payload)) as Session;
  } catch {
    return null;
  }
  if (typeof session.expiresAt !== 'number' || session.expiresAt <= now) return null;
  return session;
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function sessionFromRequest(
  request: Request,
  secret: string | undefined,
  now = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  if (!secret) return null;
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return null;
  return openSession(token, secret, now);
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// CSRF double-submit (spec): a random token in its own cookie, echoed as a
// hidden field by every server-rendered form. The cookie is HttpOnly —
// forms are rendered server-side, so no script ever needs to read it.
export function newCsrfToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

export function csrfCookie(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

// Constant-time comparison by HMAC-ing both sides with a throwaway key:
// crypto.subtle.verify is constant-time where string equality is not.
export async function csrfMatches(formValue: string, cookieValue: string | null): Promise<boolean> {
  if (!cookieValue || !formValue) return false;
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(formValue));
  return crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(cookieValue));
}
