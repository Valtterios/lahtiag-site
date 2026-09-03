import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { clearSessionCookie } from '../lib/auth';
import { checkCsrf, currentSession } from '../lib/guard';
import { revokeToken } from '../lib/discord';

// POST-only with a CSRF check: a GET logout would let any third-party page
// sign members out with an <img> tag.
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) {
    return new Response('Bad CSRF token.', { status: 403 });
  }
  // Also revoke the Discord token the session carried, so logging out kills
  // the credential itself, not only this browser's copy of it.
  const session = await currentSession(request, env);
  if (session && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    locals.cfContext.waitUntil(
      revokeToken(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET, session.accessToken),
    );
  }
  const response = redirect('/', 303);
  response.headers.append('Set-Cookie', clearSessionCookie());
  return response;
};
