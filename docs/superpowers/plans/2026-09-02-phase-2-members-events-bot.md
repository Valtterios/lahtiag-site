# Phase 2: members, events, teams and the bot

Date: 2026-09-02. Source of truth: `docs/superpowers/specs/2026-09-02-lahtiag-website-design.md`.

Phase 1 shipped the static site at https://lahtiag.fi. Phase 2 adds everything
dynamic: D1, Discord OAuth sessions, events with signups, teams with rosters,
announcements, and the HTTP-interactions bot — all in the same Worker.

## Ordered tasks

### 1. Groundwork

- Create D1 databases `lahtiag` (production) and `lahtiag-preview`.
- `migrations/0001_init.sql` with the spec schema, applied to both with
  `wrangler d1 migrations apply <db> --remote`. Migrations are forward-only and
  never run by CI.
- `wrangler.toml`: top-level `[[d1_databases]]` binding `DB` → `lahtiag`, plus
  `[env.preview]`. **Named environments inherit nothing**: `[env.preview]`
  repeats `[assets]`, `compatibility_flags`, `[observability]` and `[vars]`
  wholesale, binds `DB` → `lahtiag-preview`, and sets `workers_dev = true`.
  The preview Worker is named `lahtiag-site-preview`.
- `public/_headers`: CSP, HSTS, nosniff, referrer and permissions policies for
  every route. Required before the first `__Host-` cookie exists. The adapter
  appends its own `/_astro/*` block to this file at build time.
  CSP consequence: `build.inlineStylesheets: 'never'` in the Astro config so
  `style-src 'self'` holds without `unsafe-inline`.

### 2. Library layer (`src/lib/`)

- `auth.ts` — HMAC-SHA256 signed session cookie (`__Host-session`, HttpOnly,
  Secure, SameSite=Lax, 24 h expiry in the payload). Carries `discord_id`,
  display name, avatar hash, `is_admin`, expiry, and the user's Discord access
  token so admin writes can re-verify the role without a session store.
  Also the CSRF double-submit token (`__Host-csrf` + hidden form field).
- `discord.ts` — OAuth code exchange, `/users/@me/guilds/{guild}/member`
  lookup (200 = member, 404 = not in server, else = Discord unreachable —
  three distinct outcomes, per spec error handling), webhook posts, and
  interaction-response helpers.
- `db.ts` — one exported function per operation (`upsertMember`,
  `listUpcomingEvents`, `getEvent`, `createEvent`, `cancelEvent`, `setSignup`,
  `listSignups`, `listTeams`, `addTeamMember`, `removeTeamMember`,
  `listAnnouncements`, `createAnnouncement`…). Routes and slash commands never
  contain SQL. Signup rules (capacity, cancelled, duplicate) live here.
- `time.ts` — UTC unix seconds ↔ `Europe/Helsinki` rendering and parsing via
  `Intl`, DST-safe in both directions.
- `config.ts` keeps the guild id (unchanged, single home).

### 3. Auth routes

`/login` (redirect to Discord with `identify guilds.members.read` + `state`
cookie), `/auth/callback` (state check, code exchange, member lookup, cookie
set; not-in-server shows the invite; Discord-down says so), `/logout` (clear
cookie, POST with CSRF). Missing OAuth secrets → a friendly 503 "login not
configured yet" page instead of a crash, so the deploy order doesn't matter.

### 4. Events and signups

- `/events` (SSR): upcoming events with signup counts; past DB events below;
  link to the Phase-1 stories page (now `/history`). Admins see a create form.
- `/events/[id]` (SSR): detail, signup list with member names from the
  `members` display cache, yes/maybe buttons, cancel button for admins.
- POST handlers validate CSRF, session, and the db.ts signup rules; admin
  writes re-verify the role against Discord with the token from the cookie.
- Website changes post to Discord via `DISCORD_WEBHOOK_URL` when set.
- The Markdown `events.md` is renamed `history.md` (kept off the nav, linked
  from `/events`), because `/events` becomes a server route.

### 5. Teams

`/teams` (SSR): active teams grouped by game with rosters. Admin add/remove
by Discord id. Nav gains Events and Teams as app links merged with the
Markdown pages by `navOrder` (nav.ts grows a merge, existing tests untouched).

### 6. Announcements

`/announcements` (SSR): list from D1 (`marked` renders `body_md`), post form
for admins, webhook mirror to Discord. Bot `/announce` writes the same table
with `source = 'discord'`.

### 7. The bot

`src/pages/discord/interactions.ts`: Ed25519 verification (WebCrypto) of
`X-Signature-Ed25519`/`X-Signature-Timestamp` against `DISCORD_PUBLIC_KEY`;
bad signature → 401 before touching anything (this is also how Discord
validates the endpoint). PING → PONG. Commands `/event create`, `/event
cancel`, `/announce`, `/roster add`, `/roster remove`: admin check against
`ADMIN_ROLE_ID` from the interaction payload's member roles, **deferred
response first**, then the db.ts call in `waitUntil`, then edit the reply
(3-second rule). `scripts/register-commands.mjs` registers the commands via
the client-credentials grant (`applications.commands.update`), so no bot
token exists anywhere, matching the spec's secret list.

### 8. Tests (the spec's priority list)

Cookie sign/verify incl. tampering and expiry; admin authorisation incl. the
demoted-admin case; signup rules (capacity, cancelled, duplicate) against a
real local D1; interaction signature verification; Helsinki rendering across
both DST transitions. Vitest config gains a D1 binding + migration setup.

### 9. Deploy and hand-off

Build, `astro check`, tests, `wrangler deploy --dry-run` (bindings must be
exactly ASSETS + DB), deploy, push. Then the parts only the maintainer can do,
collected at the end of this file.

## Maintainer inputs (blocking, gathered once)

From the Discord Developer Portal (create one application, e.g. "LahtiAG
site"):

1. OAuth2 → client ID and client secret; add redirect
   `https://lahtiag.fi/auth/callback`.
2. General Information → public key (for interactions).
3. After deploy: set Interactions Endpoint URL to
   `https://lahtiag.fi/discord/interactions` (the 401-on-bad-signature check
   makes Discord accept it).

From the Discord server: the admin role id (Developer Mode → right-click the
role → Copy ID) → `ADMIN_ROLE_ID` var; a webhook URL for the announcements
channel → `DISCORD_WEBHOOK_URL`.

Secrets set with `wrangler secret put`: `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `SESSION_SECRET` (generated locally),
`DISCORD_PUBLIC_KEY`, `DISCORD_WEBHOOK_URL`.

## Traps carried over from the Phase 1 review

1. `[env.preview]` inherits nothing — repeat everything.
2. Guild id: import from `src/lib/config.ts`, never a `[vars]` entry.
3. Security headers land in `public/_headers` **before** the first cookie.
4. "Tests pass" ≠ widget confidence — the browser script still has none.
