import type { APIRoute } from 'astro';
import { clearSessionCookie } from '../lib/auth';
import { checkCsrf } from '../lib/guard';

// POST-only with a CSRF check: a GET logout would let any third-party page
// sign members out with an <img> tag.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) {
    return new Response('Bad CSRF token.', { status: 403 });
  }
  const response = redirect('/', 303);
  response.headers.append('Set-Cookie', clearSessionCookie());
  return response;
};
