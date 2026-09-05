# Member register

Date: 2026-09-05. Builds on Phase 2 (`2026-09-02-phase-2-members-events-bot.md`).

Until now the association's member register was a Google Sheet fed by a
Google Form in the nonprofit's Drive, and the "actives" list was a second
form. This moves both onto the site: a public application at /join, a
board-only register at /register with a pending queue, edit, erase, search,
CSV export and a phone-sized lookup for the door, plus a *member* mark on
event signups for linked Discord accounts.

Decisions taken with the user before building:

- Applications go to a **pending queue the board approves** (the
  Associations Act says the board decides admissions). Reject deletes.
- The actives form is **folded into /join** as one checkbox.
- The existing sheet is **imported** via `scripts/import-register.mjs`
  (user exports CSV; script emits SQL; applied with `wrangler d1 execute`).
- First version ships: register list/search/edit/erase/export, member mark
  on signups, venue lookup. Yearly re-confirmation was declined.

## Data

`migrations/0006_register.sql`: table `register`, separate from the Discord
display cache `members`. Required by law: `full_name`, `domicile`. From the
old form: `email`, `student_status` (LUT/LAB/alumni/other), `union_member`
(LTKY/KOE/none), `telegram`, `discord_name`, `games` (comma-separated),
`message`. New: `wants_active`, `board_note`, `discord_id` (optional link
to a Discord account, unique when set), `status` (pending/member/former),
`source` (web/import), timestamps and `decided_by`. Email is unique,
case-insensitively. D1 runs in EEUR.

## Code

- `src/lib/register.ts`: the fixed choices, `parseApplication(form,
  requireConsent)` returning cleaned input or the list of failing fields,
  `csvCell` (formula-injection safe).
- `src/lib/db.ts`: `applyForMembership`, `getRegisterEntry`,
  `getRegisterByDiscord`, `listRegister` (status + LIKE search with ESCAPE),
  `registerCounts`, `decideApplication`, `updateRegisterEntry`,
  `setRegisterStatus`, `eraseRegisterEntry`; `RuleError` gains
  `'duplicate'`; `listSignups` gains `is_member` via EXISTS on the register.
- `/join` (`src/pages/join.astro`): public, handles its own POST so errors
  re-render with the typed values; honeypot; signed-in applicants get
  `discord_id` from the session (never the form); board webhook notice.
- `/register`, `/register/lookup`, `/register/[id]`, `/register/[id]/action`
  (approve/reject/update/former/member/erase), `/register/export.csv`. All
  behind `requireAdmin` — reads too, since it is personal data.
  `AdminDenied.astro` renders the refusal.
- Members page and front-page CTA now link to /join; privacy page has a
  register section; SessionBox shows admins a register link.
- `wrangler.toml`: `/join`, `/register`, `/register/*` in `run_worker_first`
  (both environments). New optional secret `BOARD_WEBHOOK_URL`.
- `.gitignore`: `*.csv`, `*.import.sql`.

## Access: Google step-up instead of the Discord role

Added the same day at the user's request. Every current and former board
member keeps a lahtiag.fi Workspace account, but only the chair, the
treasurer and the maintainer should open the register, so the gate is an
explicit allowlist, not the domain.

- `src/lib/board.ts`: `__Host-board` cookie sealed with AES-GCM under a key
  derived from SESSION_SECRET plus a purpose string (a Discord session
  cookie can never open as a board cookie), 8 h TTL; `acceptGoogleUser`
  demands `email_verified`, `hd === 'lahtiag.fi'`, and allowlist
  membership; `requireBoard` re-reads the allowlist on every request.
- Allowlist = `REGISTER_ADMINS` var (fixed, recovery path) ∪ `register_admins`
  table (managed on /register by anyone with access; self-removal and
  removal of fixed accounts refused). `src/pages/register/access.ts`.
- `src/lib/google.ts` + `src/pages/auth/google.ts`, `auth/google/callback.astro`,
  `auth/google/logout.ts`: OpenID Connect code flow, `hd` hint, state cookie.
- `BoardGate.astro` replaces the Discord `AdminDenied`; `BoardBox.astro`
  shows the account and ends the sign-in. `decided_by` now stores the
  Workspace email.
- Needs from the user: an Internal OAuth client in the association's Google
  Cloud console, the two secrets, and the maintainer's own lahtiag.fi
  address added to `REGISTER_ADMINS`.

## Not done, on purpose

- No email to applicants (no mail provider in the stack).
- No Turnstile; honeypot + duplicate refusal first, Turnstile if spam appears.
- No self-service linking of an imported entry to a Discord account (no way
  to verify the email); the board links by hand from the entry page.
- Search is ASCII-case-insensitive (SQLite LIKE without ICU).

## Phase 2 (next): members manage their own entry

Agreed with the user 2026-09-05, not built yet. Members should be able to
keep their own details current without emailing the board; resigning stays
a board action (the member asks, the board marks them former).

- **Self-service edit** on /join (or a dedicated /membership page) for a
  signed-in member whose Discord account is linked: every applicant field
  (name, domicile, email, Telegram, games, "I want to be an active",
  message) is editable; status, board note and the Discord link are not.
  Same validation as the application (`parseApplication(form, false)`),
  same uniqueness rules, `updated_at` bumped; a `member_updated_at` column
  or a small change log if the board wants to see what changed.
- **Claiming an imported entry**: imported members have no Discord link,
  so they cannot self-serve. Cheapest safe route: when a signed-in user
  applies with an email that matches an unlinked entry, store a *link
  request* (entry id + Discord id + username) instead of a duplicate; the
  board sees "X (Discord: Y) says they are entry Z" in the pending queue
  and confirms with one click, which sets `discord_id`. No email
  verification exists in this stack, so the board's confirmation is the
  check.
- **Board notification** on self-service edits is probably noise; the
  register list's Since/Updated column is enough.
- **Where it lives**: the website is the place for editing (user decision
  2026-09-05). Discord gets a small read-only complement at most: a
  `/membership` slash command answering "you're a member since …" /
  "pending" / "not in the register, apply at lahtiag.fi/join" (ephemeral),
  keyed on the caller's Discord id. No editing through the bot.
- **Member role in Discord** (user asked 2026-09-05): assigning a role needs
  a bot token (`PUT /guilds/{g}/members/{u}/roles/{r}`); interactions and
  webhooks cannot do it. Plan: new secret `DISCORD_BOT_TOKEN` for a bot
  with ONLY Manage Roles, its role above the Member role; a `MEMBER_ROLE_ID`
  var; add the role on approve/link, remove on former/erase, and a "Sync
  roles" admin button on /register that reconciles all linked entries.
  Relaxes the spec's "no bot token exists anywhere" line — needs the
  user's explicit go-ahead first. The claim flow above is the prerequisite
  for imported members.
