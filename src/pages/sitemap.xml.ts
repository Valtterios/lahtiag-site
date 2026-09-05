import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { listUpcomingEvents } from '../lib/db';
import { pagePath, APP_PAGES } from '../lib/nav';

export const GET: APIRoute = async ({ url }) => {
  const pages = await getCollection('pages');
  const paths = new Set<string>(['/', '/history', '/join']);
  for (const page of pages) paths.add(pagePath(page.id));
  for (const app of APP_PAGES) paths.add(pagePath(app.id));
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const event of await listUpcomingEvents(env.DB, now)) {
      paths.add(`/events/${event.id}`);
    }
  } catch {
    // static paths alone still make a valid sitemap
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...paths].map((path) => `  <url><loc>${url.origin}${path}</loc></url>`).join('\n')}
</urlset>
`;
  return new Response(body, {
    headers: { 'content-type': 'application/xml', 'cache-control': 'public, max-age=3600' },
  });
};
