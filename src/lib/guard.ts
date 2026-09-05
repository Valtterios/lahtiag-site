// Request guards shared by every server route: session reading, CSRF
// checking, and the admin re-verification the spec requires ("Admin writes
// therefore re-verify the role against Discord rather than trusting the
// cookie" — the demoted-admin case).

import {
  CSRF_COOKIE,
  csrfMatches,
  newCsrfToken,
  readCookie,
  sessionFromRequest,
  type Session,
} from './auth';
import { fetchGuildMember, hasAdminRole } from './discord';
import { DISCORD_GUILD_ID } from './config';

export async function currentSession(
  request: Request,
  env: { SESSION_SECRET?: string },
): Promise<Session | null> {
  return sessionFromRequest(request, env.SESSION_SECRET);
}

// "View as": a board member may look at a page the way a member or a
// visitor sees it (?view=member, ?view=visitor). Rendering only; the
// routes behind the forms still check the real session.
export type ViewMode = 'board' | 'member' | 'visitor';

export function viewAs(session: Session | null, url: URL): { session: Session | null; mode: ViewMode | null } {
  if (!session?.isAdmin) return { session, mode: null };
  const wanted = url.searchParams.get('view');
  if (wanted === 'visitor') return { session: null, mode: 'visitor' };
  if (wanted === 'member') return { session: { ...session, isAdmin: false }, mode: 'member' };
  return { session, mode: 'board' };
}

export async function checkCsrf(request: Request, form: FormData): Promise<boolean> {
  const cookie = readCookie(request.headers.get('cookie'), CSRF_COOKIE);
  const field = form.get('csrf');
  return typeof field === 'string' && (await csrfMatches(field, cookie));
}

// Server-rendered forms embed the CSRF token as a hidden field; a session
// whose csrf cookie has gone missing (cleared, expired independently) gets
// a fresh one on the next page render.
interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: Record<string, unknown>): void;
}

export function ensureCsrf(cookies: CookieJar): string {
  const existing = cookies.get(CSRF_COOKIE)?.value;
  if (existing) return existing;
  const token = newCsrfToken();
  cookies.set(CSRF_COOKIE, token, {
    path: '/',
    maxAge: 24 * 60 * 60,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
  return token;
}

export type AdminCheck =
  | { ok: true; session: Session }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' | 'discord_down' };

// The cookie's is_admin flag gates what the UI shows; a write gets here and
// asks Discord again with the user's own token. A revoked role therefore
// takes effect within a couple of minutes for writes, cookie expiry or
// not. A confirmed answer is remembered per token for ADMIN_CACHE_MS, so a
// burst of board actions (recording bracket results, adding participants)
// does not ask Discord every time and trip its rate limit; and when
// Discord does not answer, a confirmation from the last ADMIN_GRACE_MS
// still counts. The lookup is a parameter only so tests can stub Discord;
// callers never pass it.
const ADMIN_CACHE_MS = 90_000;
const ADMIN_GRACE_MS = 10 * 60_000;
const adminChecks = new Map<string, { at: number; ok: boolean }>();

export function clearAdminCache(): void {
  adminChecks.clear();
}

export async function requireAdmin(
  request: Request,
  env: { SESSION_SECRET?: string; ADMIN_ROLE_ID: string },
  fetchMember: typeof fetchGuildMember = fetchGuildMember,
): Promise<AdminCheck> {
  const session = await currentSession(request, env);
  if (!session) return { ok: false, reason: 'unauthenticated' };
  const key = `${session.discordId}:${session.accessToken}`;
  const now = Date.now();
  const cached = adminChecks.get(key);
  if (cached?.ok && now - cached.at < ADMIN_CACHE_MS) return { ok: true, session };
  const membership = await fetchMember(session.accessToken, DISCORD_GUILD_ID);
  if (membership.status === 'error') {
    if (cached?.ok && now - cached.at < ADMIN_GRACE_MS) return { ok: true, session };
    return { ok: false, reason: 'discord_down' };
  }
  const ok = membership.status === 'member' && hasAdminRole(membership.roles, env.ADMIN_ROLE_ID);
  adminChecks.set(key, { at: now, ok });
  if (!ok) return { ok: false, reason: 'forbidden' };
  return { ok: true, session };
}
