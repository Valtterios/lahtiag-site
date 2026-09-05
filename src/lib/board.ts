// Step-up authentication for the member register. The register holds the
// association's personal data, so it sits behind a stronger gate than the
// rest of the admin UI: a Google Workspace sign-in with the association's
// domain, restricted to an explicit allowlist of accounts (the
// REGISTER_ADMINS var: chair, treasurer, whoever the board decides). Every
// current and former board member keeps a Workspace account, which is why
// "any lahtiag.fi account" is not enough and the list is explicit.
//
// Separate cookie, separate key, shorter life than the Discord session:
// the two prove different things and neither can stand in for the other.

import type { D1Database } from '@cloudflare/workers-types';
import { readCookie } from './auth';
import { listRegisterAdmins } from './db';

export interface BoardSession {
  email: string;
  expiresAt: number; // unix seconds
}

export const BOARD_COOKIE = '__Host-board';
export const BOARD_STATE_COOKIE = '__Host-google-state';
export const BOARD_TTL_SECONDS = 8 * 60 * 60;
export const WORKSPACE_DOMAIN = 'lahtiag.fi';

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

// Same SESSION_SECRET as the Discord session, a different derived key: a
// sealed Discord session can never be presented as a board cookie, nor the
// other way round, because neither key decrypts the other's ciphertext.
async function boardKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${secret}\nregister-board-session`),
  );
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealBoard(session: BoardSession, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await boardKey(secret),
    new TextEncoder().encode(JSON.stringify(session)),
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

export async function openBoard(token: string, secret: string, now: number): Promise<BoardSession | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const iv = b64urlDecode(token.slice(0, dot));
  const ciphertext = b64urlDecode(token.slice(dot + 1));
  if (!iv || iv.length !== 12 || !ciphertext || ciphertext.length === 0) return null;
  let payload: ArrayBuffer;
  try {
    payload = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
      await boardKey(secret),
      ciphertext as unknown as ArrayBuffer,
    );
  } catch {
    return null;
  }
  let session: BoardSession;
  try {
    session = JSON.parse(new TextDecoder().decode(payload)) as BoardSession;
  } catch {
    return null;
  }
  if (typeof session.email !== 'string' || typeof session.expiresAt !== 'number') return null;
  if (session.expiresAt <= now) return null;
  return session;
}

export function clearBoardCookie(): string {
  return `${BOARD_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// REGISTER_ADMINS: comma-separated Workspace addresses. Compared
// lower-cased; blanks ignored. An empty list means nobody gets in.
export function allowedBoardEmails(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
}

// The full allowlist: the fixed accounts from the var plus the ones added
// on the register page. The var is the recovery path if the table is ever
// emptied by mistake.
export async function boardAllowlist(env: {
  REGISTER_ADMINS?: string;
  DB?: D1Database;
}): Promise<string[]> {
  const fixed = allowedBoardEmails(env.REGISTER_ADMINS);
  const added = env.DB ? (await listRegisterAdmins(env.DB)).map((a) => a.email) : [];
  return [...new Set([...fixed, ...added])];
}

export interface GoogleUser {
  email?: string;
  email_verified?: boolean;
  hd?: string;
}

export type GoogleVerdict =
  | { ok: true; email: string }
  | { ok: false; reason: 'unverified' | 'wrong_domain' | 'not_allowed' };

// What Google told us about the signed-in account, judged against the
// policy: a verified address, on the association's Workspace (the `hd`
// claim — the hd *parameter* on the authorize URL is only a hint), and on
// the allowlist.
export function acceptGoogleUser(user: GoogleUser, allowlist: string[]): GoogleVerdict {
  const email = (user.email ?? '').trim().toLowerCase();
  if (!email || user.email_verified !== true) return { ok: false, reason: 'unverified' };
  if (user.hd !== WORKSPACE_DOMAIN || !email.endsWith(`@${WORKSPACE_DOMAIN}`)) {
    return { ok: false, reason: 'wrong_domain' };
  }
  if (!allowlist.includes(email)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, email };
}

export type BoardCheck =
  | { ok: true; email: string }
  | { ok: false; reason: 'unauthenticated' | 'unconfigured' };

// The gate in front of every register page and route. The allowlist is
// re-read on every request, so removing an address (from the var or on
// the register page) locks that person out on their next click, cookie
// or no cookie.
export async function requireBoard(
  request: Request,
  env: { SESSION_SECRET?: string; GOOGLE_CLIENT_ID?: string; REGISTER_ADMINS?: string; DB?: D1Database },
  now = Math.floor(Date.now() / 1000),
): Promise<BoardCheck> {
  if (!env.SESSION_SECRET || !env.GOOGLE_CLIENT_ID) return { ok: false, reason: 'unconfigured' };
  const allowlist = await boardAllowlist(env);
  if (allowlist.length === 0) return { ok: false, reason: 'unconfigured' };
  const token = readCookie(request.headers.get('cookie'), BOARD_COOKIE);
  if (!token) return { ok: false, reason: 'unauthenticated' };
  const session = await openBoard(token, env.SESSION_SECRET, now);
  if (!session || !allowlist.includes(session.email)) return { ok: false, reason: 'unauthenticated' };
  return { ok: true, email: session.email };
}
