# LahtiAG website redesign: design

Date: 2026-09-02
Status: approved design, not yet implemented

## Context

LahtiAG is a gaming association with roughly 260 Discord members. Its current site is a Google Sites page with an embedded Discord widget. Google Sites has proven limiting: its embed sanitiser strips inline style attributes and script tags from pasted code, embed blocks are a fixed pixel height that cannot respond to neighbouring content, and there is no way to add member accounts or structured data.

The replacement is a Cloudflare-hosted site with Discord-backed member accounts, event signups and roster management.

## Goals

1. Public, English-language content pages the maintainer edits as Markdown in git.
2. Members sign in with Discord. Membership and admin rights derive from the Discord server.
3. Event and tournament signups.
4. Team and roster management.
5. A Discord bot that reads and writes the same data through slash commands.
6. Runs on the Cloudflare free tier.

## Non-goals

- Multi-language content. English only.
- A content management UI. The maintainer edits Markdown directly.
- Automatic mirroring of a Discord announcements channel. Deferred, see Deferred work.
- Recurring events, waitlists, file uploads, email notifications.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Hosting | Single Cloudflare Worker with static assets | One deploy, no CORS, static pages cost no Worker invocations |
| Framework | Astro in SSR mode | Markdown-first content with per-route server rendering |
| Database | D1 | Free tier covers this scale by orders of magnitude |
| Sessions | Stateless signed cookies | No session store to read, write or expire |
| Identity | Discord OAuth, roles read from the guild | No member list to maintain, access revokes itself |
| Bot | Discord HTTP Interactions inside the same Worker | No second host, no persistent connection, same database |
| CI | Cloudflare Workers Builds | Builds from GitHub on push, no tokens to store |

### Why not a separate API Worker

Splitting content and API buys separation that nothing currently needs, at the cost of CORS configuration, two deploys, two secret sets and cookie domain complexity. If an external bot later needs the API, the `/api/v1/*` routes described below are added to the same Worker. A true split remains a contained refactor because all data access already sits behind one module.

## Architecture

A single Worker serves the apex domain.

- Static assets (prerendered Markdown pages, CSS, images) are served from Cloudflare's edge without invoking the Worker.
- Server routes handle authentication, events, signups and admin writes.
- `/discord/interactions` receives Discord slash commands.

Bindings:

- `DB`: D1 database `lahtiag`.

No KV, R2 or Durable Objects. Sessions are stateless, images live in the repository until uploads are genuinely needed.

Secrets, set with `wrangler secret put` and never committed: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, `DISCORD_PUBLIC_KEY`, `DISCORD_WEBHOOK_URL`.

Plain vars in `wrangler.toml`: `DISCORD_GUILD_ID`, `ADMIN_ROLE_ID`.

Environments: production on the apex domain; branch and PR previews on `*.workers.dev`, bound to a **separate D1 database** so preview deployments cannot write to real signups.

## Authentication and authorisation

Login redirects to Discord with scopes `identify` and `guilds.members.read`. The callback exchanges the code and calls `/users/@me/guilds/{guild}/member`.

- HTTP 200 means the user is in the LahtiAG server, so they are a member.
- The `roles` array containing `ADMIN_ROLE_ID` means they are an admin.
- HTTP 404 means they are not in the server. They are shown the invite link.

The session cookie is HMAC-SHA256 signed with `SESSION_SECRET` and carries `discord_id`, display name, avatar hash, `is_admin` and an expiry. It is `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`, and lives for 24 hours.

Because the cookie is stateless, a demoted admin retains the flag until expiry. Admin writes therefore re-verify the role against Discord rather than trusting the cookie. Re-login is invisible in practice because Discord remembers the authorisation.

CSRF: a `state` parameter on the OAuth redirect, and a double-submit token on all mutating forms.

## Data model

Times are stored as UTC unix integers and rendered in `Europe/Helsinki`. Storing local wall-clock time would silently shift events across the two annual DST transitions.

```sql
CREATE TABLE members (
  discord_id   TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  avatar_hash  TEXT,
  last_seen    INTEGER NOT NULL
);

CREATE TABLE teams (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  game    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE team_members (
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  discord_id TEXT    NOT NULL REFERENCES members(discord_id),
  position   TEXT,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, discord_id)
);

CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT,
  starts_at          INTEGER NOT NULL,
  capacity           INTEGER,
  team_id            INTEGER REFERENCES teams(id),
  created_by         TEXT NOT NULL REFERENCES members(discord_id),
  created_at         INTEGER NOT NULL,
  cancelled_at       INTEGER,
  discord_message_id TEXT
);

CREATE TABLE signups (
  event_id   INTEGER NOT NULL REFERENCES events(id),
  discord_id TEXT    NOT NULL REFERENCES members(discord_id),
  status     TEXT    NOT NULL CHECK (status IN ('yes','maybe')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, discord_id)
);

CREATE TABLE announcements (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  body_md            TEXT NOT NULL,
  published_at       INTEGER NOT NULL,
  author_id          TEXT NOT NULL REFERENCES members(discord_id),
  source             TEXT NOT NULL CHECK (source IN ('web','discord')),
  discord_message_id TEXT
);

CREATE INDEX idx_events_starts_at ON events(starts_at);
CREATE INDEX idx_signups_event    ON signups(event_id);
```

Notes:

- `members` is a display cache, not an account table. Arbitrary Discord users cannot be looked up without a bot token, so signup lists would otherwise show raw IDs for anyone not currently logged in. It is written on every login and every bot interaction.
- `events.team_id` is nullable: an event is association-wide or belongs to one team.
- `teams.game` allows a member to sit in different squads per game.
- `capacity` is displayed and enforced at signup time. There is no waitlist, because promotion logic is only useful alongside notifications, which are out of scope.
- `discord_message_id` lets the bot edit its existing Discord post when an event or announcement changes, instead of posting again.

## Discord bot

The bot runs as an HTTP Interactions endpoint inside the Worker. Discord's Interactions Endpoint URL points at `/discord/interactions`. Requests are verified with Ed25519 against `DISCORD_PUBLIC_KEY`; unverified requests get HTTP 401, which is also how Discord validates the endpoint when it is first configured.

Commands:

```
/event create name: date: time: [capacity:] [team:]
/event cancel id:
/announce text:
/roster add user: team:
/roster remove user: team:
```

Authorisation reuses the same role check: the interaction payload includes the invoking member's roles, so admin-only commands compare against `ADMIN_ROLE_ID`.

Every command acknowledges with a deferred response before doing database work, then edits the reply. Discord terminates interactions that do not respond within 3 seconds, which otherwise produces "The application did not respond" even when the write succeeded.

Changes made on the website post to Discord through `DISCORD_WEBHOOK_URL`, so both surfaces stay consistent regardless of where the change originated.

### If the bot moves off Workers

Automatic channel mirroring needs a persistent gateway connection, which a Worker cannot hold. The maintainer has a personal server running Docker and an AMP panel that other members can access, either of which can host a gateway bot.

In that case the external bot must call the site's `/api/v1/*` routes with a shared service secret. It must not talk to D1 directly. This keeps validation in one place, avoids a Cloudflare API token sitting on a shared machine, and avoids D1's slower external REST API. It also means the bot can move between hosts without touching the data layer.

Availability note: the website and slash commands would remain independent of that server. Only mirroring would depend on it.

## Repository layout

```
src/content/pages/     Markdown for static pages
src/pages/             Astro routes
src/lib/auth.ts        cookie sign and verify, role checks
src/lib/discord.ts     OAuth exchange, member lookup, webhook posts
src/lib/db.ts          D1 access, one function per operation
src/pages/discord/     interactions endpoint and command handlers
migrations/            numbered, forward-only
wrangler.toml
```

Routes:

- Static: `/`, `/about`, `/teams`, and any further Markdown pages.
- Server: `/events`, `/events/[id]`, `/login`, `/auth/callback`, `/logout`, and POST handlers for signups and admin writes.
- Machine: `/discord/interactions`, and later `/api/v1/*` behind a service token.

`db.ts` exposes one function per operation, for example `createEvent`, `listUpcomingEvents`, `setSignup`. Routes never contain raw SQL. This is what allows a web form, a slash command and a future external bot to share one copy of the validation.

## Error handling

- Static pages have no runtime dependencies, so a Discord or D1 outage degrades events and login only. The site stays up.
- Login failures distinguish "you are not in the Discord server" from "Discord is unreachable", because those require different actions from the user.
- Signup writes are rejected when an event is cancelled or full.
- Interaction signature failures return 401 without touching the database.

## Testing

Vitest with `@cloudflare/vitest-pool-workers`, which runs tests inside the real Workers runtime against a local D1 rather than against mocks.

Priority coverage:

- Cookie signing and verification, including tampering and expiry.
- Admin authorisation, including the demoted-admin case.
- Signup rules: capacity, cancelled events, duplicate signups.
- Interaction signature verification.
- Helsinki time rendering across both DST transitions.

## Operations

- Push to `main` deploys production through Workers Builds.
- Migrations are run deliberately with `wrangler d1 migrations apply`. Workers Builds deploys code but does not touch the database, so schema changes are ordered: add the column, deploy code tolerating both shapes, then backfill.
- D1 has no undo, which is why preview deployments bind to a separate database.
- Observability through Workers Logs.

## Cost

Zero per month on top of the existing domain. Free tier allowances are 5 million D1 rows read per day, 100,000 written per day and 5 GB of storage, against an association of roughly 260 people. The first paid step, if ever needed, is 5 USD per month.

## Assumptions

1. Teams are stable named squads, so `team_members` needs no date range. Ad-hoc per-tournament lineups would require one.
2. The apex domain is already on Cloudflare DNS, so no nameserver move is required. The domain name itself is supplied at deploy time.
3. The Discord server has a single admin role. Multiple privilege tiers would replace `ADMIN_ROLE_ID` with a role-to-permission map.

## Deferred work

- Automatic mirroring of a Discord announcements channel.
- Recurring events.
- Waitlists and notifications.
- `/api/v1/*` service-token routes, added when an external bot exists.
- Retiring the standalone widget at valtterios.github.io/discord-widget once its component is part of this site.

## Open questions

1. The domain name.
2. Whether existing Google Sites content is migrated or rewritten.
