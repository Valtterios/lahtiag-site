import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { authorizeUrl } from '../lib/discord';

// Server route on purpose (no prerender): it must see the request origin
// and set a per-request state cookie.

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.SESSION_SECRET) {
    // Deploy order independence: the code can ship before the Discord
    // application's secrets exist.
    return redirect('/auth/unavailable');
  }

  // CSRF on the OAuth redirect (spec): a random state, kept in a short-lived
  // cookie and compared on the way back. The cookie also records whether
  // this attempt was the silent (prompt=none) one, so the callback knows a
  // code-less bounce means "retry with the consent screen" rather than a
  // failed login. ?retry=1 is that retry.
  const silent = url.searchParams.get('retry') !== '1';
  // Optional return path, a site-relative one only (never a host): the
  // join page's sign-in button sends people back to the join page.
  const next = url.searchParams.get('next') ?? '';
  if (/^\/[a-z0-9\-\/]*$/i.test(next) && !next.startsWith('//')) {
    cookies.set('__Host-next', next, { path: '/', maxAge: 600, httpOnly: true, secure: true, sameSite: 'lax' });
  }
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  cookies.set('__Host-oauth-state', `${state}.${silent ? 'silent' : 'consent'}`, {
    path: '/',
    maxAge: 600,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });

  return redirect(authorizeUrl(env.DISCORD_CLIENT_ID, `${url.origin}/auth/callback`, state, silent));
};
