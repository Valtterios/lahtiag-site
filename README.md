# LahtiAG website

The public site of LahtiAG, a gaming association in Lahti. Static pages are
Markdown in git, built with Astro and served by a Cloudflare Worker with
static assets.

## Adding or editing a page

1. Add `src/content/pages/<name>.md`, directly in that folder with no
   subdirectories. The page is served at `/<name>`. `home.md` is special: it
   is the site root, `/`.
2. Frontmatter fields:
   - `title` (required): page heading, browser title and nav label.
   - `description` (optional): meta description.
   - `navOrder` (optional): include in the header nav, sorted ascending.
     Leave it out to keep the page reachable by URL but unlisted.
3. Commit and push to `main`. Cloudflare Workers Builds builds and deploys
   the site automatically.

## Working locally

- `npm install`
- `npm run dev` for a live-reloading dev server
- `npm run build` then `npm run preview` to serve the exact production build
- `npm test` runs the test suite inside the Cloudflare Workers runtime
- `npm run check` type-checks the Astro files

## Deployment

The site is live at <https://lahtiag.fi> (custom domain on the Worker; the
`workers.dev` route is disabled, so that is the only URL).

Push to `main` deploys production through Cloudflare Workers Builds. The
Worker is named `lahtiag-site` (see `wrangler.toml`). `npm run deploy`
deploys from a laptop, which is only needed for the very first deploy or
for emergencies.
