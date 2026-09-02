// Stateless sessions (spec, Authentication): an HMAC-SHA256 signed cookie,
// no server-side store. The payload carries the user's Discord access token
// because admin writes must re-verify the role against Discord (the
// demoted-admin case) and, with no session store and no bot token in the
// design, the user's own token is the only credential available later.

export interface Session {
  discordId: string;
  username: string;
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

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(session));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), payload);
  return `${b64urlEncode(payload)}.${b64urlEncode(new Uint8Array(mac))}`;
}

// Signature first, then expiry: a tampered token never gets its payload
// parsed. Any malformed input returns null rather than throwing.
export async function verifySession(
  token: string,
  secret: string,
  now: number,
): Promise<Session | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = b64urlDecode(token.slice(0, dot));
  const mac = b64urlDecode(token.slice(dot + 1));
  if (!payload || !mac) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    mac as unknown as ArrayBuffer,
    payload as unknown as ArrayBuffer,
  );
  if (!valid) return null;
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
  return verifySession(token, secret, now);
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
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
