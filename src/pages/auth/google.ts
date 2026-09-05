import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { newCsrfToken } from '../../lib/auth';
import { BOARD_STATE_COOKIE } from '../../lib/board';
import { googleAuthorizeUrl } from '../../lib/google';

// Start of the register sign-in: a random state in a short-lived cookie,
// then off to Google. Always lands back on /register afterwards; there is
// no `next` parameter to validate.

export const GET: APIRoute = async ({ url, redirect, cookies }) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    return redirect('/register', 302);
  }
  const state = newCsrfToken();
  cookies.set(BOARD_STATE_COOKIE, state, {
    path: '/',
    maxAge: 10 * 60,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
  return redirect(googleAuthorizeUrl(env.GOOGLE_CLIENT_ID, `${url.origin}/auth/google/callback`, state), 302);
};
