import { defineMiddleware } from 'astro:middleware';

// Security headers for SERVER-RENDERED responses. public/_headers covers
// only what Cloudflare serves as static assets; anything rendered by the
// Worker — exactly the routes that carry the session cookie — must set the
// same headers here. Keep the two lists in sync.
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' https://cdn.discordapp.com; font-src 'self'; connect-src 'self' https://discord.com https://cloudflareinsights.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
});
