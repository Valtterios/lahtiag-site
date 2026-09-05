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
accounts to manage. Anyone, signed in or not, can apply for membership at
/join.

The **member register** is the exception: it holds personal data, so it
opens only to a short list of the association's Google Workspace accounts
(chair, treasurer, and whoever they add), signed in with Google — see the
next section.

## Hosting a tournament, start to finish

Everything can be run from Discord with `/tournament` (admin only, only you
see the panel). It opens on three categories — **Event**, **Bracket**, and
**Announce & screen** — and each button below lives in one of them (Back
returns to the categories):

1. **📅 Create event** (Event) — fill the form. A team size makes it a
   tournament-style event where members form their own teams on the site;
   empty means individual signups. The announcement posts itself to the
   webhook channel.
2. Members sign up (and create/join teams) on the event page.
3. **🔒 Close signups** (Event) when the field is set.
4. **🎲 Generate bracket** (Bracket) — random seeding, byes handled
   automatically. The same button re-seeds from scratch if needed.
5. Put the bracket on the venue screen: open the event's bracket page as an
   admin, click **Open presenter mode**, fullscreen it (F11). It scales to
   fill the display and refreshes itself every 10 seconds. The direct URL is
   `/events/<id>/bracket?display` if the display machine isn't signed in.
6. **🏆 Record winner** (Bracket) after each match — the pick appears on
   the venue screen within ten seconds. Repeat down to the champion; the
   banner and the Hall of Fame on /history update themselves.
   **↩️ Revert result** undoes a recorded win: the match becomes undecided
   again and everything that followed from it is cleared. On the website
   the ↺ button on the recorded winner does the same.
7. **💬 Screen message** (Announce & screen) puts a one-line banner on the
   venue screen ("Finals in 5 minutes!"); submit it empty to clear.
8. **📣 Announce** publishes to the site's News page and the Discord channel
   at once. **❌ Cancel event** (Event) if the day falls through.

Editing event details (times, capacity, organizers, stream link,
description) and permanently deleting an event are done on the website —
event page → Admin. Delete (in the Danger zone) erases signups, teams, and
bracket, and removes the Discord announcement; cancel keeps the history.

The Admin panel's **Manage participants** section edits the roster directly,
skipping the normal signup rules (closed signups, capacity): change anyone's
answer (Going/Maybe), move them between teams (team size still holds), or
**add a walk-in participant by name** — someone without Discord. A manual
participant behaves like any other signup afterwards: they land in brackets,
can be edited, removed (× on their chip), and purged.

Winner clicks on the *website* re-verify your role against Discord each
time; the Discord panel doesn't need to and is immune to rate limits — on
tournament day, prefer the panel.

## The member register

The association's member list (the one the Associations Act requires) lives
on the site at **/register**, replacing the Google Form + Sheet. The way in
is the footer link **Member register (board)** on every page; anyone else
who clicks it only sees "Board members only".

**Who can open it.** Not the Discord role: the register needs a sign-in
with a lahtiag.fi Google Workspace account that is on the access list. The
sign-in lasts eight hours (a separate cookie from the Discord one; "End
register sign-in" on the page ends it early, do that on a shared device).
The access list has two parts: the fixed accounts in `wrangler.toml`
(`REGISTER_ADMINS`, the recovery path — chair and treasurer) and the
accounts added on the register's **Access** page. Anyone with access can grant it to another lahtiag.fi address
or remove one; nobody can remove themselves, and the fixed ones can only be
changed in `wrangler.toml`. Removal takes effect on the person's next
click, signed in or not. When a board changes: add the new chair/treasurer
on the page, remove the old ones, and update `REGISTER_ADMINS` at leisure.

Google side (one-time, done in the association's Google Cloud console under
the Workspace): APIs & Services → OAuth consent screen, user type
**Internal** (only lahtiag.fi accounts can even start the flow) → Credentials
→ Create OAuth client ID, type *Web application*, authorised redirect URIs
`https://lahtiag.fi/auth/google/callback` (and the preview Worker's
`https://lahtiag-site-preview.<account>.workers.dev/auth/google/callback` if
previews should reach the register). Put the client id and secret in with
`npx wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Until
both exist the register answers "Register access isn't set up yet" to
everyone, including the fixed accounts. Turn on 2-step verification for the
Workspace accounts on the list; the register is only as safe as they are.

- **Applying**: /join is the public form (linked from the Members page and
  the front page). Full name, home municipality, email, school and student
  union are required; Discord and Telegram names, games, "I want to be an
  active", and a message are optional; the consent box is required. An
  applicant who is signed in gets their Discord account linked
  automatically. New applications are announced to the board's private
  channel when the `BOARD_WEBHOOK_URL` secret is set.
- **Deciding**: pending applications sit at the top of /register with
  Approve / Reject. Approve makes them a member and records who decided;
  Reject deletes the application (a refused applicant's data has no reason
  to stay). Nothing is emailed either way: tell them on Discord or by mail
  if you like. Someone who applied while signed in sees their status on
  /join.
- **Membership type** follows the rules (4 §): *full* (current LUT/LAB
  students, set automatically from what they picked), *external* (everyone
  else who applies; the old sheet called this "outside"), *supporting* and
  *honorary* (board-set only, on the entry page). The sheet's "Membership
  type" column is imported and mapped onto these.
- **The list**: searchable by name, email, Discord or Telegram name
  (accents don't matter: "aijo" finds Äijö), filterable by status and
  actives. Click a name for the full entry: every field is editable
  (including linking a Discord id by hand — Developer Mode → Copy ID), plus
  a board-only note. **Mark as former member** ends a membership but keeps
  the record; **Erase** deletes it for good, which is the answer to a GDPR
  erasure request. Event signups are separate data: "Remove a member
  everywhere" on /events handles those.
- **Add entry** (toolbar) is for people who don't come through the form:
  honorary members invited by the general meeting, supporting members,
  applications on paper. The entry records who added it.
- **Hints on applications**: a red note when someone says LUT/LAB but
  applies from a non-student address, a yellow one when a similar name or
  email is already in the register. Hints only; the board decides.
- **Housekeeping** appears on the register when there are applications
  older than 60 days nobody decided, or former members two years on. It
  suggests; nothing is deleted on its own.
- **Numbers for the annual report** sit at the bottom of the register:
  current members by class, by school, and joined per year.
- **Access** (toolbar) is the list of Google accounts that can open the
  register; see "Who can open it" above.
- **Discord link requests**: a member from the old form who signs in with
  Discord can ask, on /join, to have that account linked to their entry by
  giving the email they registered with. The request shows at the top of
  /register with the Discord name the entry already had next to the
  requesting account: **Confirm link** when they match (or you know the
  person), **Dismiss** otherwise. Nothing tells the requester whether the
  email existed. Once linked, the member manages their own actives status.
- **Actives**: a linked member ticks "I want to be an active" on /join
  themselves (and gives their Telegram handle); the board channel gets a
  notice and someone adds them to the Telegram group. The **Actives only**
  box on /register lists everyone who has ticked it.
- **At the door**: /register/lookup is the phone view. Type a name, see
  MEMBER / PENDING / FORMER in big letters. On event pages, admins also see
  a small *member* mark next to signups from linked Discord accounts.
- **Export**: the Export CSV button on /register downloads the list (or the
  filtered status) for the annual report or a backup. Treat the file as
  personal data: keep it in the association's Drive, not on a laptop
  desktop.
- **Search caveat**: matching is ASCII case-insensitive only, so "äijö"
  and "ÄIJÖ" differ. Search a lower-case fragment if in doubt.
- **Spam**: the form has a hidden honeypot field and refuses duplicate
  emails. If junk applications ever show up, add Cloudflare Turnstile
  (needs a script-src CSP entry for challenges.cloudflare.com) — not done
  because it hasn't been needed.

Importing the old sheet (one-time, done from a laptop, never from the
Worker): see the header of `scripts/import-register.mjs`. In short: export
the responses sheet as CSV, `node scripts/import-register.mjs file.csv
--dry-run` to check the column mapping, then generate the SQL and apply it
with `npx wrangler d1 execute lahtiag --remote --file=…`. Both files are
gitignored (`*.csv`, `*.import.sql`); shred them afterwards.

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
| Member register | `migrations/0006_register.sql`; form choices + validation in `src/lib/register.ts`; pages under `src/pages/register/` and `src/pages/join.astro`; import script `scripts/import-register.mjs` |
| Register sign-in (Google) | `src/lib/board.ts` (board cookie, allowlist, `requireBoard`), `src/lib/google.ts` (OAuth calls), routes `src/pages/auth/google*`; fixed allowlist `REGISTER_ADMINS` in `wrangler.toml`, the rest in the `register_admins` table |
| Auth (cookies, CSRF) | `src/lib/auth.ts`, `src/lib/guard.ts` — stateless HMAC-signed session cookie, 24 h |
| Discord API calls | `src/lib/discord.ts` (server side); `src/lib/discord-widget.ts` is the browser widget's and stays separate |
| The bot | `src/pages/discord/interactions.ts` — HTTP Interactions, Ed25519-verified, no bot token exists anywhere |
| Slash-command definitions | `scripts/register-commands.mjs` — run after changing commands: `DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… node scripts/register-commands.mjs` |
| Security headers | `public/_headers` (static assets) **and** `src/middleware.ts` (Worker responses) — keep the two CSPs identical |
| Helsinki time handling | `src/lib/time.ts` — storage is UTC unix seconds, always |
| Brand assets | `public/brand/`; the Canva kit is the source of truth (blue #4169e1, yellow #ffde59, ink #1e1e1e, Chakra Petch ≈ the wordmark) |

Secrets (set with `npx wrangler secret put NAME`, never committed):
`SESSION_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`DISCORD_PUBLIC_KEY`, `DISCORD_WEBHOOK_URL`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` (the register sign-in), and the optional
`BOARD_WEBHOOK_URL` (a webhook into a board-only channel; membership
applications are announced there by name and school). The Discord application lives
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
