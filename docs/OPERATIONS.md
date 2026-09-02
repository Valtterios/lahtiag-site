# Running lahtiag.fi

The operations handbook for the LahtiAG website. Written for whoever runs
this after the current maintainer — board members included. Last full
revision: September 2026.

## What this is

One Cloudflare Worker serves https://lahtiag.fi. Static pages (home, members,
contact, rules, history stories) are Markdown in this repository, prerendered
at build time and served from Cloudflare's edge. Dynamic pages (events,
signups, tournaments, news, login) render in the Worker against a D1
database. There is no separate server anywhere and the whole thing runs on
Cloudflare's free tier.

- Site: https://lahtiag.fi (the `workers.dev` URL is disabled; www redirects
  to the apex via the tiny separate Worker in `infra/www-redirect/`)
- Repository: https://github.com/Valtterios/lahtiag-site — push to `main`
  deploys automatically through Cloudflare Workers Builds, live in ~2 min
- Cloudflare account: lahtiagry@gmail.com
- Calendar feed: https://lahtiag.fi/events.ics

## Who can do what

Everyone in the LahtiAG Discord can sign in (Sign in with Discord), sign up
to events, and form tournament teams. Holders of the Board member role (ids
in `wrangler.toml` under `ADMIN_ROLE_ID`) additionally get the admin
controls, on the site and in Discord. Access follows Discord: leaving the
server or losing the role removes access by itself — there are no separate
accounts to manage.

## Hosting a tournament, start to finish

Everything can be run from Discord with `/tournament` (admin only, only you
see the panel):

1. **📅 Create event** — fill the form. A team size makes it a
   tournament-style event where members form their own teams on the site;
   empty means individual signups. The announcement posts itself to the
   webhook channel.
2. Members sign up (and create/join teams) on the event page.
3. **🔒 Close signups** when the field is set.
4. **🎲 Generate bracket** — random seeding, byes handled automatically.
   The same button re-seeds from scratch if needed.
5. Put the bracket on the venue screen: open the event's bracket page as an
   admin, click **Open presenter mode**, fullscreen it (F11). It scales to
   fill the display and refreshes itself every 10 seconds. The direct URL is
   `/events/<id>/bracket?display` if the display machine isn't signed in.
6. **🏆 Record winner** after each match — the pick appears on the venue
   screen within ten seconds. Repeat down to the champion; the banner and
   the Hall of Fame on /history update themselves.
7. **💬 Screen message** puts a one-line banner on the venue screen
   ("Finals in 5 minutes!"); submit it empty to clear.
8. **📣 Announce** publishes to the site's News page and the Discord channel
   at once. **❌ Cancel event** if the day falls through.

Fixing a wrongly recorded result, editing event details (times, capacity,
organizers, stream link, description), and permanently deleting an event are
done on the website — event page → Admin. Delete (in the Danger zone)
erases signups, teams, and bracket, and removes the Discord announcement;
cancel keeps the history.

Winner clicks on the *website* re-verify your role against Discord each
time; the Discord panel doesn't need to and is immune to rate limits — on
tournament day, prefer the panel.

## Editing the site's pages

Add or edit Markdown in `src/content/pages/`, push to `main`, done. A page
`<name>.md` is served at `/<name>`. Frontmatter: `title` (required),
`description`, and `navOrder` (leave out to keep the page off the nav).
Two reserved names: `home.md` is the front page, `history.md` gets the
tournament Hall of Fame prepended. Files must sit directly in the folder —
no subdirectories.

## The moving parts

| Thing | Where |
|---|---|
| Worker + assets + routes + vars | `wrangler.toml` (root); preview env repeats EVERYTHING — named environments inherit nothing |
| Database schema | `migrations/`, forward-only, applied **manually**: `npx wrangler d1 migrations apply lahtiag --remote` (and `lahtiag-preview --env preview`) — CI never touches the database |
| All SQL | `src/lib/db.ts`, one function per operation; routes and bot handlers never contain SQL |
| Auth (cookies, CSRF) | `src/lib/auth.ts`, `src/lib/guard.ts` — stateless HMAC-signed session cookie, 24 h |
| Discord API calls | `src/lib/discord.ts` (server side); `src/lib/discord-widget.ts` is the browser widget's and stays separate |
| The bot | `src/pages/discord/interactions.ts` — HTTP Interactions, Ed25519-verified, no bot token exists anywhere |
| Slash-command definitions | `scripts/register-commands.mjs` — run after changing commands: `DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… node scripts/register-commands.mjs` |
| Security headers | `public/_headers` (static assets) **and** `src/middleware.ts` (Worker responses) — keep the two CSPs identical |
| Helsinki time handling | `src/lib/time.ts` — storage is UTC unix seconds, always |
| Brand assets | `public/brand/`; the Canva kit is the source of truth (blue #4169e1, yellow #ffde59, ink #1e1e1e, Chakra Petch ≈ the wordmark) |

Secrets (set with `npx wrangler secret put NAME`, never committed):
`SESSION_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`DISCORD_PUBLIC_KEY`, `DISCORD_WEBHOOK_URL`. The Discord application lives
in the [developer portal](https://discord.com/developers/applications) under
the association's account; its custom emojis (`lag_*`, used by the panel
buttons) live in the app's Emojis tab.

## Local development

```bash
git clone git@github.com:Valtterios/lahtiag-site.git && cd lahtiag-site
npm install        # approve the esbuild/workerd install scripts if asked
npm test           # the whole suite runs inside the real Workers runtime
npm run check      # type-checks .astro files
npm run build
npx wrangler deploy --dry-run   # binding list should be exactly ASSETS + DB + ADMIN_ROLE_ID
```

Node 24 is pinned in `.nvmrc`. `astro dev` daemonizes (`astro dev stop` to
kill it). Deploying by hand (`npx wrangler deploy`) needs `npx wrangler
login` with the lahtiagry account; pushing to `main` needs no credentials
at all and is the normal path.

## Things that will bite you

- **Server routes must be listed in `run_worker_first`** (`wrangler.toml`,
  both environments). Cloudflare's asset router answers browser navigations
  to unlisted non-asset paths with the 404 page without ever invoking the
  Worker — and curl won't catch it. Test new SSR routes with
  `curl -H 'Sec-Fetch-Mode: navigate'`.
- **CSP forbids inline scripts and styles.** `assetsInlineLimit: 0` and
  `inlineStylesheets: 'never'` in `astro.config.mjs` keep Astro from
  inlining; remove either and pages break silently.
- **Env access is `import { env } from 'cloudflare:workers'`** and the
  execution context is `Astro.locals.cfContext`. `Astro.locals.runtime.env`
  throws in this adapter version.
- **The Discord invite code is read live from widget.json on every page
  load** — never hardcode one, they expire.
- **The lahtiag.fi DNS zone carries the association's Google Workspace
  mail.** Never touch the MX or TXT records.
- **D1 has no undo** (Time Travel gives 30 days of point-in-time restore).
  Previews bind a separate database (`lahtiag-preview`) for exactly this
  reason.

## When something breaks

- **Discord widget stuck or erroring on the front page**: Discord server
  settings → Widget → confirm *Enable Server Widget* is on. That toggle is
  the only production failure mode it has.
- **Login errors** distinguish three cases on purpose: not in the Discord
  server (join first), Discord unreachable (wait, retry), stale attempt
  (just retry). "Discord didn't answer while re-checking your role" during
  rapid admin clicking is rate limiting — wait a few seconds, or use the
  Discord panel instead.
- **Site down?** Check Cloudflare's status and the Workers Builds tab for a
  failed deploy; a failed build never replaces the running version. Logs:
  Workers & Pages → lahtiag-site → Logs.
- **Bad deploy**: `git revert` the offending commit and push — the build
  pipeline redeploys the previous behaviour in ~2 minutes.
