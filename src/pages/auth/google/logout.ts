import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../../lib/guard';
import { clearBoardCookie } from '../../../lib/board';

// Ends the register sign-in only; the Discord session is untouched.

export const POST: APIRoute = async ({ request }) => {
  void env;
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) {
    return new Response(null, { status: 303, headers: { location: '/register?err=csrf' } });
  }
  return new Response(null, {
    status: 303,
    headers: { location: '/register', 'set-cookie': clearBoardCookie() },
  });
};
