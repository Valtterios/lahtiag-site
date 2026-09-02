# LahtiAG website: handoff

Written 2026-09-02. Continue from here on another machine.

## Where things stand

Phase 1 is code complete, reviewed and merged. Nothing is deployed yet.

- Repo: https://github.com/Valtterios/lahtiag-site (public), `main` at `0ed98a3`
- 16 commits: 3 planning documents, 8 implementation, 8 fix wave, 1 merge
- 32 tests passing inside the real Workers runtime, `astro check` clean
- `wrangler deploy --dry-run` succeeds; the only binding is `env.ASSETS`
- No Cloudflare account has ever been touched. No Worker exists yet.

What is built: a static English-language site with a Home page, an About page, a 404 page, all from Markdown, plus the Discord widget as a native component. What is not: everything from Phase 2 onward (Discord OAuth, D1, events, teams, the bot).

## Getting set up on the new machine

```bash
git clone https://github.com/Valtterios/lahtiag-site.git
cd lahtiag-site
npm install
npm test          # expect 3 files, 32 passed
npm run build     # expect dist/client and dist/server
npm run dev       # local dev server
```

Node 24 is pinned in `.nvmrc`. Anything below 22.12 fails: Astro 7 requires it.

`npm run preview` daemonizes rather than blocking on Windows. On Linux or macOS it behaves normally.

## What to do next, in order

### 1. Confirm the widget actually works in a browser

This is the one piece of Phase 1 that was never verified, because no subagent could open a browser. Everything else has command-line evidence behind it.

Run `npm run dev`, open the home page, and confirm:

- The server name, the online count and the total member count all appear
- The server icon loads, not the placeholder square
- The avatar grid fills with online members and the status dots are coloured
- Hovering an avatar shows the username, and a game name when someone is playing
- The Join Server button is present and the link works
- DevTools Network shows exactly two `discord.com` requests: `widget.json`, then the invite endpoint

If the widget shows "Couldn't load the Discord widget": check Discord, Server Settings, Widget, and confirm **Enable Server Widget** is still on. That is the only way this widget fails in production, and the failure comes from a change in Discord, not from this repository.

If the header shows the server name but no total member count and no icon, the invite request failed. That is deliberate partial degradation, not a bug. It usually fixes itself on reload, because the invite code expires and is re-read on every load.

### 2. Deploy for the first time (plan Task 6)

The GitHub half is already done, so only the Cloudflare half remains.

```bash
npx wrangler login          # interactive, opens a browser
npx wrangler whoami         # confirm the right account
npm run build
npx wrangler deploy
```

That prints a `*.workers.dev` URL. Record it in `README.md` where `WORKERS_DEV_URL` is referenced. Open it and repeat the browser checks above against the deployed site.

Then connect Workers Builds so pushes deploy automatically. In the Cloudflare dashboard: Workers and Pages, select the `lahtiag-site` Worker, Settings, Builds, Connect GitHub, choose `Valtterios/lahtiag-site`.

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Branch: `main`
- Build variables: none. Node comes from `.nvmrc`.

The Worker name in the dashboard must be exactly `lahtiag-site`, matching `name` in `wrangler.toml`, or the build fails.

Prove push-to-deploy works before trusting it: change something visible, push to `main`, watch the build run, then curl the deployed URL and confirm the change is live.

### 3. Attach the domain (plan Task 7)

Blocked until you choose the domain. It goes in exactly two places:

1. `wrangler.toml`, a new `[[routes]]` block with `custom_domain = true`
2. `astro.config.mjs`, the `site` key, which later phases use to build absolute URLs such as the OAuth callback

DNS is already on Cloudflare, so no nameserver move is needed. Remove the old Google Sites DNS records first.

Decide `www` explicitly. Cloudflare custom domains match exactly, so attaching the apex leaves `www` dead unless you add a redirect.

Then retire the Google Sites page and the standalone widget at `valtterios.github.io/discord-widget`, which this component replaces.

## Open decisions

| Decision | Status | Where it lands |
|---|---|---|
| Domain name | Not chosen | `wrangler.toml`, `astro.config.mjs` |
| Google Sites copy: migrate or rewrite | Not chosen | `src/content/pages/*.md`, currently marked placeholder prose |
| `www` redirect or not | Not chosen | Cloudflare DNS, at domain attachment |

## Editing the site

Add a page by adding `src/content/pages/<name>.md`. It is served at `/<name>`.

Two rules the build enforces:

- Files must sit **directly** in `src/content/pages/`. A subfolder produces an id containing a slash, which the single-segment `[id]` route cannot hold. The collection glob is `*.md` so subfolders are ignored rather than crashing the build.
- `home.md` is reserved: it is the site root, `/`, rendered by `index.astro`, and is excluded from `[id].astro`.

Frontmatter is validated by a Zod schema in `src/lib/page-schema.ts`: `title` required, `description` and `navOrder` optional. A page without `navOrder` does not appear in the nav.

## Things that will bite you if you do not know them

**The invite code is re-read on every page load and must never be hardcoded.** Discord expires it. `widget.json` carries neither the server icon nor the total member count, which is the entire reason for the second request. Collapsing that into a constant breaks the widget days later, which is the worst kind of breakage.

**`.wrangler/` must stay gitignored.** The generated `.wrangler/deploy/config.json` contains Windows backslash paths when built on Windows. It works only because Cloudflare's Linux builder regenerates it. Commit it once from Windows and every CI build fails.

**`nav.ts`'s `?? 0` in the sort comparator is not dead code.** `.filter()` is not a type predicate, so TypeScript does not narrow the element type, and removing the fallback fails `astro check`. It is unreachable at runtime and required at compile time. I recorded it as dead code during review and was wrong.

**Adapter defaults quietly add bindings the spec forbids.** Two were caught and disabled: KV-backed sessions (`session: false`) and Cloudflare Images (`imageService: 'passthrough'`). Both would have provisioned account resources nothing uses. If a future adapter upgrade reintroduces a binding, `wrangler deploy --dry-run` shows the binding list.

**`html_handling = "drop-trailing-slash"`** in `wrangler.toml` exists because `pagePath` emits `/about` with no trailing slash. Without it every nav click costs a redirect. Do not remove it without changing `pagePath` too.

## Phase 2 groundwork

The spec at `docs/superpowers/specs/2026-09-02-lahtiag-website-design.md` covers Discord OAuth, D1, events, signups, teams and the bot. There is no Phase 2 plan yet; write one from the spec when you start.

Four traps the final review identified for whoever does:

1. **Wrangler named environments do not inherit top-level config.** The moment `[env.preview]` exists for the separate preview D1, every one of `[assets]`, `compatibility_flags`, `[observability]` and the vars must be repeated inside it, and the Worker name becomes `lahtiag-site-preview` unless overridden.
2. **The guild id has one home,** `src/lib/config.ts`, re-exported from `discord-widget.ts`. Server code must import from there. Do not add a `DISCORD_GUILD_ID` to `[vars]`: the widget runs in the browser and cannot read a Worker var, so that creates two sources of truth.
3. **No security headers exist yet.** No CSP, no HSTS. Irrelevant for static Phase 1, relevant the moment a `__Host-` session cookie exists. The adapter appends to `_headers`, so a hand-written `public/_headers` is the place.
4. **Test coverage is aimed at the safest code.** All 32 tests cover pure string and number transforms. The genuinely fragile surfaces, the browser script and the asset routing, have no automated coverage. Do not read "32 tests pass" as confidence about the widget.

## The Discord bot, when you get there

The spec's decision is HTTP Interactions running inside the same Worker at `/discord/interactions`: slash commands and a right-click "publish to site", no persistent connection, no second host.

Automatic mirroring of an announcements channel needs a gateway connection, which a Worker cannot hold. That is deferred. Your second machine has SSH access to the AMP host, so a gateway bot has an easy home there when you want it.

One rule holds regardless of where that bot runs: **it calls the site's `/api/v1/*` routes with a shared service secret and never touches D1 directly.** That keeps validation in one place, keeps a Cloudflare API token off a shared machine, and lets the bot move hosts without touching the data layer.

## Reference

| Command | Purpose |
|---|---|
| `npm run dev` | Local dev server |
| `npm test` | 32 tests inside workerd |
| `npm run check` | Type check `.astro` files |
| `npm run build` | Build to `dist/` |
| `npx wrangler deploy --dry-run` | Validate config and show the binding list without uploading |
| `npx wrangler deploy` | Deploy from the laptop |
| `node -p "JSON.stringify(require('./dist/server/wrangler.json').assets)"` | Inspect the generated assets config |

Key files: `wrangler.toml` (Worker name, assets, trailing-slash handling), `astro.config.mjs` (server output, disabled session and image services), `src/lib/config.ts` (guild id), `src/components/DiscordWidget.astro` (the widget), `src/lib/discord-widget.ts` (its tested helpers).
