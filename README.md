# LahtiAG website

The website of LahtiAG (Lahti Association of Gaming LAG ry), live at
<https://lahtiag.fi>. Astro on a single Cloudflare Worker with D1: Markdown
content pages, Discord sign-in, events with individual and team signups,
tournament brackets with a venue presenter mode, news, an iCal feed, and a
Discord bot that runs the whole tournament day from a `/tournament` panel.

**Start with [docs/OPERATIONS.md](docs/OPERATIONS.md)** — the handbook for
running the site: hosting tournaments, editing pages, the moving parts,
secrets, and what to do when something breaks.

## Quick reference

- Edit a page: change `src/content/pages/<name>.md`, push to `main`,
  live in ~2 minutes via Cloudflare Workers Builds.
- `npm install && npm test` — 115 tests inside the real Workers runtime.
- `npm run check` type-checks, `npm run build` builds, `npm run dev` serves
  locally (the dev server daemonizes; `npx astro dev stop` ends it).
- Database migrations are manual and forward-only:
  `npx wrangler d1 migrations apply lahtiag --remote`.

The design spec and phase plans that shaped this are under
`docs/superpowers/`.
