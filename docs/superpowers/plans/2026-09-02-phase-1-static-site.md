# LahtiAG Website Phase 1: Static Site on Cloudflare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Google Sites page with a deployed, English-language static website on Cloudflare Workers, built from Markdown files in git, with the existing Discord widget as a native Astro component and a working Vitest harness for later phases.

**Architecture:** One Astro project in the repo root, using the Cloudflare adapter in `output: 'server'` mode with every Phase 1 page marked `prerender = true`, so all pages ship as static assets served from Cloudflare's edge and the Worker only runs for unknown paths (the 404). Public pages are a Markdown content collection (`src/content/pages/*.md`) rendered through one base layout; the Discord widget is a client-side component that keeps the two-hop fetch (widget.json, then the invite endpoint) from the standalone widget. Deployment is Cloudflare Workers Builds watching the `main` branch of a GitHub repo under `Valtterios`.

**Tech Stack:** Node 24 (Astro requires >= 22.12), npm, Astro 7.2, `@astrojs/cloudflare` 14.2 (which builds on the Cloudflare Vite plugin, so `astro dev` and `astro preview` run in the real Workers runtime `workerd`), Wrangler 4.128, Vitest 4.1 with `@cloudflare/vitest-plugin` 1.1, TypeScript 5.9, `gh` CLI, Cloudflare Workers Builds, Cloudflare custom domains.

**Spec:** `docs/superpowers/specs/2026-09-02-lahtiag-website-design.md` (this plan implements the static-content, hosting, CI and testing-harness parts of it; see "Phase 1 scope" below for what it deliberately leaves out).

## Global Constraints

- English only. No i18n routing, no locale folders, no language switcher (spec: Non-goals).
- Hosting is "a single Cloudflare Worker with static assets"; no KV, R2 or Durable Objects; runs on the Cloudflare free tier (spec: Decisions, Architecture, Cost).
- Framework is "Astro in SSR mode": `output: 'server'` in `astro.config.mjs`, with every Phase 1 page carrying `export const prerender = true` so it is built to a static file (spec: Decisions; Architecture "Static assets (prerendered Markdown pages, CSS, images) are served from Cloudflare's edge without invoking the Worker").
- Wrangler configuration lives in `wrangler.toml` (spec: Repository layout), not `wrangler.jsonc`.
- Markdown for public pages lives in `src/content/pages/`; Astro routes live in `src/pages/` (spec: Repository layout).
- CI is "Cloudflare Workers Builds. Builds from GitHub on push, no tokens to store" (spec: Decisions). Push to `main` deploys production (spec: Operations).
- Testing is Vitest running inside the Workers runtime. The spec names `@cloudflare/vitest-pool-workers`; Cloudflare has since renamed that package to `@cloudflare/vitest-plugin` and its docs say "If you use `@cloudflare/vitest-pool-workers`, refer to Migrate to Vitest plugin" and that "the package API and Vitest configuration are unchanged". This plan uses `@cloudflare/vitest-plugin`.
- Node `>= 22.12.0` (Astro 7 engine requirement). The machine has Node v24.15.0 and npm 11.12.1. Workers Builds' default Node is 24.x, so no version file is needed.
- The domain name is not decided. It is referred to throughout as the variable `SITE_DOMAIN` and is written into the repo only in Task 7, which states exactly where.
- Whether the old Google Sites copy is migrated or rewritten is undecided. Phase 1 ships correctly structured pages whose prose is honest placeholder text, each paragraph clearly marked for replacement. Do not block on real copy.
- Commit messages must contain no em dashes, no `Co-Authored-By` trailer and no AI attribution. A hook blocks the commit otherwise. Every commit message in this plan complies; keep it that way when you adapt one.
- The Discord guild id is `1210598510999633971`. The invite code must never be hardcoded: widget.json carries neither the server icon nor the total member count, the invite endpoint carries both, and the invite code expires, so it is re-read from widget.json on every page load.
- No secrets exist in Phase 1. Nothing goes in `.dev.vars`; nothing is set with `wrangler secret put`.
- Shell: commands are written for Git Bash (POSIX). Where PowerShell 5.1 differs it is noted: `&&` is not available there (run the commands one at a time), and `curl` is an alias for `Invoke-WebRequest`, so type `curl.exe` instead.

### Phase 1 scope

Phase 1 ends with a deployed static site on Cloudflare, on `SITE_DOMAIN`, with a Home page, an About page, a 404 page, the Discord widget on the Home page, and `npm test` passing inside `workerd`. It explicitly does NOT include D1 or any database, Discord OAuth, sessions, events, signups, teams, the bot, `/api` routes, migrations, or the `DISCORD_GUILD_ID`/`ADMIN_ROLE_ID` Worker vars (there is no server code yet to read them). Those are later phases and have no tasks here.

### Repository layout after Phase 1

```
astro.config.mjs                 Astro config: server output + Cloudflare adapter
wrangler.toml                    Worker name, entrypoint, compatibility, static assets
vitest.config.ts                 Vitest inside workerd via @cloudflare/vitest-plugin
package.json, package-lock.json
tsconfig.json
.gitignore
README.md                        How to add a page, how to run, how it deploys
public/robots.txt
src/content.config.ts            Declares the `pages` collection
src/content/pages/home.md        Markdown for /
src/content/pages/about.md       Markdown for /about
src/lib/page-schema.ts           Zod schema for page frontmatter (tested)
src/lib/nav.ts                   Pure helpers: page id -> path, nav links (tested)
src/lib/discord-widget.ts        Pure helpers + types for the widget (tested)
src/layouts/Base.astro           Header, nav, footer, stylesheet
src/styles/site.css              The site stylesheet
src/components/DiscordWidget.astro
src/pages/index.astro            Renders the `home` entry
src/pages/[id].astro             Renders every other entry at /<id>
src/pages/404.astro              Prerendered 404 page
test/page-schema.test.ts
test/nav.test.ts
test/discord-widget.test.ts
docs/                            Already present, untouched
```

### Things an engineer new to this stack needs to know

- **Astro** renders `.astro` files (HTML with a `---` frontmatter block of TypeScript that runs at build time) into pages. A "content collection" is a folder of Markdown files with a schema for their frontmatter; `getCollection('pages')` returns them and `render(entry)` turns one into a `<Content />` component. A `<script>` tag inside an `.astro` component is bundled by Astro, may import TypeScript from `src/`, and runs in the browser.
- **Cloudflare Workers with static assets**: the build produces a `dist/` folder. Files in it are uploaded as static assets and served directly; requests that match no file go to the Worker script (Astro's server entry), which in Phase 1 only ever renders the 404 page.
- **Wrangler** is Cloudflare's CLI. `wrangler deploy` uploads the Worker and its assets; `--dry-run` does everything except upload, which makes it a good local check. With the Cloudflare Vite plugin, the build writes a generated Wrangler config and a small redirect file at `.wrangler/deploy/config.json` that `wrangler deploy` and `wrangler dev` honour automatically.
- **Workers Builds** is Cloudflare's hosted CI: it watches a GitHub branch, runs your build command, then your deploy command. The Worker name in the dashboard must equal `name` in `wrangler.toml` or the build fails.
- **Vitest + `@cloudflare/vitest-plugin`** runs test files inside `workerd` (the same runtime as production) instead of Node. Phase 1 tests are pure functions, but the harness is what later phases use for D1, cookies and signature checks.

---

### Task 1: Scaffold the Astro project for Cloudflare Workers

The deliverable is a project that builds, passes `wrangler deploy --dry-run`, and serves a page locally from the built output. Nothing here is unit-testable; each step states the command and the output that proves it.

**Files:**
- Create: `package.json`
- Create: `astro.config.mjs`
- Create: `wrangler.toml`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/pages/index.astro` (temporary; replaced in Task 3)

**Interfaces:**
- Consumes: nothing.
- Produces: npm scripts `dev`, `build`, `preview`, `check`, `test`, `deploy`; the Worker name `lahtiag-site` (used by Tasks 6 and 7); the `dist/` output directory; `src/pages/` as the routes folder.

- [ ] **Step 1: Confirm the starting state**

Run (from the repo root, `C:\Users\k430431\Local Projects\Claude\lahtiag-site`):

```bash
git log --oneline && git status --short && ls
```

Expected: exactly one commit, a clean tree, and only `docs` listed. If `package.json` already exists, stop: someone has started this task already.

- [ ] **Step 2: Create `package.json`**

Create `package.json`:

```json
{
  "name": "lahtiag-site",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12.0"
  },
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "check": "astro check",
    "test": "vitest run",
    "deploy": "astro build && wrangler deploy"
  },
  "dependencies": {
    "@astrojs/cloudflare": "^14.2.6",
    "astro": "^7.2.10"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.10",
    "@cloudflare/vitest-plugin": "^1.1.3",
    "typescript": "^5.9.0",
    "vitest": "^4.1.11",
    "wrangler": "^4.128.0"
  }
}
```

Why these: `@astrojs/cloudflare` 14 requires `astro ^7.2` and `wrangler ^4.125`; `@cloudflare/vitest-plugin` 1.1 requires `vitest ^4.1`; `@astrojs/check` plus `typescript` are what `astro check` needs to type-check `.astro` files.

- [ ] **Step 3: Install**

Run:

```bash
npm install
```

Expected: ends with `added N packages` and no `ERESOLVE` error. Then confirm the versions that matter:

```bash
node -p "require('astro/package.json').version + ' ' + require('@astrojs/cloudflare/package.json').version + ' ' + require('wrangler/package.json').version"
```

Expected: three versions starting `7.`, `14.`, `4.` respectively.

- [ ] **Step 4: Create `astro.config.mjs`**

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// output: 'server' is the spec's "Astro in SSR mode". Every Phase 1 page
// opts back into static output with `export const prerender = true`, so
// the Worker itself only ever renders the 404 page. Later phases add
// server routes by simply not exporting prerender.
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
});
```

- [ ] **Step 5: Create `wrangler.toml`**

```toml
# The dashboard Worker name must equal this `name` (Workers Builds requires it).
name = "lahtiag-site"

# With @astrojs/cloudflare 13+ the entrypoint is a package specifier; the
# adapter resolves it during `astro build`. Do not point this at dist/.
main = "@astrojs/cloudflare/entrypoints/server"

compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "404-page"

[observability]
enabled = true
```

- [ ] **Step 6: Create `tsconfig.json`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 7: Create `.gitignore`**

```
node_modules/
dist/
.astro/
.wrangler/
.dev.vars
.env
.env.*
npm-debug.log*
```

- [ ] **Step 8: Create a temporary `src/pages/index.astro`**

This exists only so the build has a page. Task 3 replaces it.

```astro
---
export const prerender = true;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>LahtiAG</title>
  </head>
  <body>
    <h1>LahtiAG</h1>
  </body>
</html>
```

- [ ] **Step 9: Build**

Run:

```bash
npm run build
```

Expected (approximately; Astro's exact wording varies by minor version): a line mentioning `prerendering static routes`, a line for `/index.html`, and a final `Complete!` line, exit code 0. Then:

```bash
ls dist && ls dist/index.html
```

Expected: `dist/index.html` exists.

Verify: the plan assumes the adapter writes a redirect file for Wrangler. Run `cat .wrangler/deploy/config.json`. Expected: a one-line JSON object with a `configPath` key pointing into `dist/`. If that file does not exist, `wrangler deploy` will read `wrangler.toml` directly, in which case check whether `dist/_worker.js/index.js` exists; if it does, change `main` in `wrangler.toml` to `"./dist/_worker.js/index.js"` and note that in the commit message. If neither the redirect file nor `dist/_worker.js/` exists, stop and read the `@astrojs/cloudflare` README in `node_modules/@astrojs/cloudflare/` before continuing; the plan's next steps depend on this.

- [ ] **Step 10: Dry-run the deploy**

Run:

```bash
npx wrangler deploy --dry-run
```

Expected: no error, output listing the Worker `lahtiag-site`, a `Total Upload` size, and a final line containing `--dry-run: exiting now.` It must NOT prompt for login (a dry run needs no account).

- [ ] **Step 11: Serve the built site locally**

Open a second terminal in the repo root and run:

```bash
npm run preview
```

Expected: a line printing a local URL, normally `http://localhost:4321/`. Back in the first terminal:

```bash
curl -s http://localhost:4321/ | grep -o '<h1>LahtiAG</h1>'
```

Expected output: `<h1>LahtiAG</h1>`. Stop the preview server with Ctrl+C afterwards.

Verify: with `@astrojs/cloudflare` 13+, `astro preview` is documented to run the built site inside `workerd` through the Cloudflare Vite plugin. If `npm run preview` errors out (for example complaining that preview is not supported by the adapter), use Wrangler directly instead: `npx wrangler dev` in the second terminal, which honours the generated config from Step 9, and prints `http://localhost:8787/`; repeat the `curl` against port 8787. Whichever command works, use the same one in Tasks 3 and 5 and record the choice in `README.md` in Task 3.

PowerShell note: use `curl.exe -s http://localhost:4321/ | Select-String '<h1>LahtiAG</h1>'`.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json astro.config.mjs wrangler.toml tsconfig.json .gitignore src/pages/index.astro
git commit -m "Scaffold Astro 7 with the Cloudflare adapter and wrangler config"
```

---

### Task 2: Vitest harness inside workerd, page frontmatter schema and nav helpers

The deliverable is `npm test` running inside the Workers runtime with real tests: the Zod schema that every Markdown page must satisfy, and the pure helpers the layout's navigation uses. These are the first pieces a reviewer can reject on their own merits (wrong id-to-path rule, wrong sort), which is why they are tested here rather than inside the layout.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/lib/page-schema.ts`
- Create: `src/lib/nav.ts`
- Test: `test/page-schema.test.ts`
- Test: `test/nav.test.ts`

**Interfaces:**
- Consumes: the `test` npm script from Task 1.
- Produces:
  - `pageSchema` (a Zod object schema) and `type PageFrontmatter = { title: string; description?: string; navOrder?: number }` from `src/lib/page-schema.ts`.
  - `pagePath(id: string): string` (`'home'` -> `'/'`, anything else -> `'/' + id`) and `navLinks(entries: NavSource[]): NavLink[]` with `interface NavSource { id: string; data: { title: string; navOrder?: number } }` and `interface NavLink { href: string; label: string }` from `src/lib/nav.ts`.
  - The convention that the test folder is `test/` and test files end in `.test.ts`.

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// Tests run inside workerd, the Workers runtime, not Node. Phase 1 has no
// bindings, so the runtime is configured inline instead of from
// wrangler.toml: that file's `main` is the Astro adapter entrypoint, which
// only resolves inside an Astro build and would fail to load here.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Write the failing schema test**

Create `test/page-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pageSchema } from '../src/lib/page-schema';

describe('pageSchema', () => {
  it('accepts a page with only a title', () => {
    const result = pageSchema.safeParse({ title: 'About' });
    expect(result.success).toBe(true);
  });

  it('accepts description and navOrder', () => {
    const result = pageSchema.safeParse({
      title: 'Home',
      description: 'The LahtiAG gaming association',
      navOrder: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.navOrder).toBe(1);
    }
  });

  it('rejects a missing title', () => {
    expect(pageSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(pageSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a non-integer navOrder', () => {
    expect(pageSchema.safeParse({ title: 'x', navOrder: 1.5 }).success).toBe(false);
  });

  it('runs inside the Workers runtime, not Node', () => {
    // workerd identifies itself this way; Node has no navigator.userAgent
    // of this value. This is the proof that the harness is the real thing.
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });
});
```

- [ ] **Step 3: Run it and watch it fail for the right reason**

Run:

```bash
npx vitest run test/page-schema.test.ts
```

Expected: FAIL with an error resolving `../src/lib/page-schema` (wording like `Failed to resolve import` or `Cannot find module`). The failure must be about the missing module, not about the harness.

Verify: if instead the run fails before reaching the test with a message about a missing Worker entry point or `main`, the plugin in this version insists on a script. Create `test/worker-stub.ts` containing exactly:

```ts
// Only exists to satisfy the Vitest plugin; Phase 1 tests never call it.
export default {
  fetch(): Response {
    return new Response('not used', { status: 501 });
  },
};
```

and add `main: './test/worker-stub.ts',` inside the `cloudflareTest({ ... })` options in `vitest.config.ts`, then rerun. If the failure mentions `compatibilityDate` being newer than the installed runtime supports, lower it to the date the message names and keep `wrangler.toml` in sync.

- [ ] **Step 4: Implement the schema**

Create `src/lib/page-schema.ts`:

```ts
// Astro re-exports its own Zod build at `astro/zod`; using it here keeps the
// schema on the same Zod instance that `defineCollection` validates with.
import { z } from 'astro/zod';

export const pageSchema = z.object({
  // Shown in the <title>, the <h1> and the navigation label.
  title: z.string().min(1),
  // Optional <meta name="description">.
  description: z.string().optional(),
  // Pages with a navOrder appear in the header nav, sorted ascending.
  // Pages without one are reachable by URL but not listed.
  navOrder: z.number().int().optional(),
});

export type PageFrontmatter = z.infer<typeof pageSchema>;
```

- [ ] **Step 5: Run the schema test and see it pass**

Run:

```bash
npx vitest run test/page-schema.test.ts
```

Expected: `6 passed`.

Verify: if the import of `astro/zod` fails to resolve inside the test runtime, install Zod directly with `npm install zod@^4.4.3` (the same major Astro 7 bundles) and change the import in `src/lib/page-schema.ts` to `import { z } from 'zod';`. Astro accepts the schema either way because it only calls its parse methods.

- [ ] **Step 6: Write the failing nav test**

Create `test/nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pagePath, navLinks } from '../src/lib/nav';

describe('pagePath', () => {
  it('maps the home entry to the site root', () => {
    expect(pagePath('home')).toBe('/');
  });

  it('maps any other id to /<id>', () => {
    expect(pagePath('about')).toBe('/about');
  });
});

describe('navLinks', () => {
  it('lists only pages with a navOrder, sorted ascending', () => {
    const links = navLinks([
      { id: 'about', data: { title: 'About', navOrder: 2 } },
      { id: 'privacy', data: { title: 'Privacy' } },
      { id: 'home', data: { title: 'Home', navOrder: 1 } },
    ]);
    expect(links).toEqual([
      { href: '/', label: 'Home' },
      { href: '/about', label: 'About' },
    ]);
  });

  it('returns an empty list when nothing is ordered', () => {
    expect(navLinks([{ id: 'x', data: { title: 'X' } }])).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run:

```bash
npx vitest run test/nav.test.ts
```

Expected: FAIL resolving `../src/lib/nav`.

- [ ] **Step 8: Implement the nav helpers**

Create `src/lib/nav.ts`:

```ts
// Shape shared by content-collection entries and by tests. A collection
// entry from `getCollection('pages')` satisfies this structurally.
export interface NavSource {
  id: string;
  data: { title: string; navOrder?: number };
}

export interface NavLink {
  href: string;
  label: string;
}

// The entry named `home` is the site root; every other entry lives at /<id>.
export function pagePath(id: string): string {
  return id === 'home' ? '/' : `/${id}`;
}

export function navLinks(entries: NavSource[]): NavLink[] {
  return entries
    .filter((entry) => typeof entry.data.navOrder === 'number')
    .sort((a, b) => (a.data.navOrder ?? 0) - (b.data.navOrder ?? 0))
    .map((entry) => ({ href: pagePath(entry.id), label: entry.data.title }));
}
```

- [ ] **Step 9: Run the whole suite**

Run:

```bash
npm test
```

Expected: `2 files`, `10 passed`, exit code 0.

- [ ] **Step 10: Commit**

```bash
git add vitest.config.ts src/lib/page-schema.ts src/lib/nav.ts test/page-schema.test.ts test/nav.test.ts
git commit -m "Add Vitest harness in workerd with page schema and nav helpers"
```

If Step 3's fallback created `test/worker-stub.ts`, add it to the `git add` line.

---

### Task 3: Content collection, base layout, stylesheet and Markdown routes

The deliverable is the maintainer's workflow: add `src/content/pages/<name>.md`, get `/<name>` in the site chrome. Home, About and a 404 page ship here with placeholder prose. Verified by building and curling the served output; the pure parts were tested in Task 2.

**Files:**
- Create: `src/content.config.ts`
- Create: `src/content/pages/home.md`
- Create: `src/content/pages/about.md`
- Create: `src/styles/site.css`
- Create: `src/layouts/Base.astro`
- Modify: `src/pages/index.astro` (replace the Task 1 placeholder entirely)
- Create: `src/pages/[id].astro`
- Create: `src/pages/404.astro`
- Create: `README.md`

**Interfaces:**
- Consumes: `pageSchema` from `src/lib/page-schema.ts`; `navLinks` from `src/lib/nav.ts`.
- Produces: the `pages` collection (entry ids equal the Markdown filename without `.md`; `home` is reserved for `/`); `Base.astro` with `interface Props { title: string; description?: string }` and a default `<slot />` for the page body; CSS class names `site-header`, `site-main`, `site-footer`, `prose` that Task 5 relies on staying stable.

- [ ] **Step 1: Declare the collection**

Create `src/content.config.ts`:

```ts
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { pageSchema } from './lib/page-schema';

// Every .md file under src/content/pages becomes one entry whose id is the
// filename without extension: about.md -> 'about' -> served at /about.
const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: pageSchema,
});

export const collections = { pages };
```

- [ ] **Step 2: Write the Home page Markdown**

Create `src/content/pages/home.md`:

```markdown
---
title: Home
description: LahtiAG is a gaming association based in Lahti, Finland.
navOrder: 1
---

<!-- PLACEHOLDER COPY: replace or migrate from Google Sites. Decision pending (spec open question 2). -->

LahtiAG is a gaming association based in Lahti. This paragraph is placeholder
text that describes, in one or two sentences, who we are and what we do. It is
marked for replacement and must not ship past Phase 1 review.

## What we do

<!-- PLACEHOLDER COPY -->

Placeholder: a short list of the activities the association runs, such as
regular gaming nights, tournaments and community events. Replace with real
copy.

## Join us on Discord

Most of what happens in LahtiAG happens on our Discord server. Presence and
the join link are live below.
```

- [ ] **Step 3: Write the About page Markdown**

Create `src/content/pages/about.md`:

```markdown
---
title: About
description: What LahtiAG is, how it is run and how to get in touch.
navOrder: 2
---

<!-- PLACEHOLDER COPY: replace or migrate from Google Sites. Decision pending (spec open question 2). -->

## The association

Placeholder: when LahtiAG was founded, what it exists to do and roughly how
many members it has (about 260 on Discord at the time of writing). Replace
with real copy.

## How it is run

Placeholder: who the board or organisers are and how decisions are made.
Replace with real copy.

## Contact

Placeholder: the association's contact channel. Until real copy exists, the
Discord server on the home page is the contact point.
```

- [ ] **Step 4: Write the stylesheet**

Create `src/styles/site.css`. Visual design is not this phase's job; this is a deliberately plain sheet that stops the site looking like an unstyled default and gives later design work sensible hooks.

```css
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --text: #1c1e21;
  --muted: #5c5e66;
  --line: #e3e5e8;
  --accent: #5865f2;
  --accent-dark: #4752c4;
  --measure: 60rem;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  color-scheme: light;
}

body {
  margin: 0;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--text);
  background: var(--bg);
}

a {
  color: var(--accent);
}

a:hover {
  color: var(--accent-dark);
}

.site-header {
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

.site-header .inner {
  max-width: var(--measure);
  margin: 0 auto;
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.brand {
  font-weight: 700;
  font-size: 1.25rem;
  color: var(--text);
  text-decoration: none;
}

.site-header nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 1rem;
}

.site-header nav a {
  color: var(--muted);
  text-decoration: none;
  padding: 0.25rem 0;
  border-bottom: 2px solid transparent;
}

.site-header nav a:hover,
.site-header nav a[aria-current="page"] {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.site-main {
  flex: 1 0 auto;
  width: 100%;
  max-width: var(--measure);
  margin: 0 auto;
  padding: 2rem 1rem 3rem;
}

.prose h1 {
  margin-top: 0;
  font-size: 2rem;
  line-height: 1.2;
}

.prose h2 {
  margin-top: 2rem;
  font-size: 1.4rem;
}

.prose p,
.prose ul,
.prose ol {
  max-width: 44rem;
}

.site-footer {
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.875rem;
}

.site-footer .inner {
  max-width: var(--measure);
  margin: 0 auto;
  padding: 1rem;
}
```

- [ ] **Step 5: Write the base layout**

Create `src/layouts/Base.astro`:

```astro
---
import { getCollection } from 'astro:content';
import { navLinks } from '../lib/nav';
import '../styles/site.css';

interface Props {
  title: string;
  description?: string;
}

const { title, description } = Astro.props;

// The nav is built from the collection at build time, so a new Markdown
// file with a navOrder appears in the header without touching this file.
const links = navLinks(await getCollection('pages'));
const currentPath = Astro.url.pathname.replace(/\/+$/, '') || '/';
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} | LahtiAG</title>
    {description && <meta name="description" content={description} />}
  </head>
  <body>
    <header class="site-header">
      <div class="inner">
        <a class="brand" href="/">LahtiAG</a>
        <nav aria-label="Main">
          <ul>
            {links.map((link) => (
              <li>
                <a href={link.href} aria-current={currentPath === link.href ? 'page' : undefined}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
    <main class="site-main">
      <slot />
    </main>
    <footer class="site-footer">
      <div class="inner">
        <p>LahtiAG is a gaming association in Lahti, Finland. This site is maintained as Markdown in git.</p>
      </div>
    </footer>
  </body>
</html>
```

Note on Astro 7: its default compiler is strict about HTML, so every non-void element must be closed, and whitespace between inline elements is stripped by default (`compressHTML: 'jsx'`). Nav items are block-level `<li>` elements precisely so that stripping cannot glue links together.

- [ ] **Step 6: Replace `src/pages/index.astro`**

Overwrite the file from Task 1 with:

```astro
---
import { getEntry, render } from 'astro:content';
import Base from '../layouts/Base.astro';

export const prerender = true;

const entry = await getEntry('pages', 'home');
if (!entry) {
  throw new Error('src/content/pages/home.md is required: it is the site root.');
}
const { Content } = await render(entry);
---
<Base title={entry.data.title} description={entry.data.description}>
  <article class="prose">
    <h1>{entry.data.title}</h1>
    <Content />
  </article>
</Base>
```

- [ ] **Step 7: Create the route for every other page**

Create `src/pages/[id].astro` (the square brackets are literal; in Git Bash quote the path when creating it):

```astro
---
import { getCollection, render } from 'astro:content';
import Base from '../layouts/Base.astro';

export const prerender = true;

// One static path per Markdown file, except `home`, which index.astro owns.
export async function getStaticPaths() {
  const pages = await getCollection('pages');
  return pages
    .filter((page) => page.id !== 'home')
    .map((page) => ({ params: { id: page.id }, props: { entry: page } }));
}

const { entry } = Astro.props;
const { Content } = await render(entry);
---
<Base title={entry.data.title} description={entry.data.description}>
  <article class="prose">
    <h1>{entry.data.title}</h1>
    <Content />
  </article>
</Base>
```

- [ ] **Step 8: Create the 404 page**

Create `src/pages/404.astro`:

```astro
---
import Base from '../layouts/Base.astro';

export const prerender = true;
---
<Base title="Page not found">
  <article class="prose">
    <h1>Page not found</h1>
    <p>There is nothing at this address. Try the <a href="/">home page</a>.</p>
  </article>
</Base>
```

- [ ] **Step 9: Build and check the output files**

Run:

```bash
npm run build && ls dist dist/about
```

Expected: build exits 0; `dist/index.html`, `dist/404.html` and `dist/about/index.html` exist (Astro's default `build.format` is `directory`, so `/about` becomes `about/index.html`).

Verify: if `dist/about/index.html` is missing but the build succeeded, the collection ids are not what the plan assumes. Add this line temporarily inside the frontmatter of `src/pages/[id].astro`, rebuild and read the output: `console.log((await getCollection('pages')).map((p) => p.id));`. Expected `[ 'about', 'home' ]`. If the ids carry a folder prefix or a different casing, adjust the reserved id in `src/lib/nav.ts` (`pagePath`) and in `index.astro`/`[id].astro` to match, update `test/nav.test.ts` accordingly, and remove the console.log.

- [ ] **Step 10: Serve and curl the three routes**

In a second terminal run `npm run preview` (or `npx wrangler dev` if Task 1 Step 11 settled on that; port 8787 instead of 4321). Then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/
curl -s http://localhost:4321/ | grep -c 'aria-label="Main"'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/about
curl -s http://localhost:4321/about | grep -o '<h1>About</h1>'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/no-such-page
curl -s http://localhost:4321/no-such-page | grep -o 'Page not found' | head -1
```

Expected, line by line: `200`, `1`, `200`, `<h1>About</h1>`, `404`, `Page not found`.

Verify: the 404 status is the one place the Worker (not a static file) answers. If the last two lines give `200` and nothing, the unknown path is being answered by something other than Astro's 404 route; check `not_found_handling = "404-page"` is present in `wrangler.toml` and that `dist/404.html` exists. If the status is `404` but the body is empty, the asset layer answered without the page; that is acceptable for Phase 1 but note it in the commit message so Phase 2 (which adds server routes) revisits it.

Stop the preview server.

- [ ] **Step 11: Type-check the `.astro` files**

Run:

```bash
npm run check
```

Expected: `0 errors`. Warnings are acceptable; errors are not.

- [ ] **Step 12: Write the README**

Create `README.md`:

```markdown
# LahtiAG website

The public site of LahtiAG, a gaming association in Lahti. Static pages are
Markdown in git, built with Astro and served by a Cloudflare Worker with
static assets.

## Adding or editing a page

1. Add `src/content/pages/<name>.md`. The page is served at `/<name>`.
   `home.md` is special: it is the site root, `/`.
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

Push to `main` deploys production through Cloudflare Workers Builds. The
Worker is named `lahtiag-site` (see `wrangler.toml`). `npm run deploy`
deploys from a laptop, which is only needed for the very first deploy or
for emergencies.
```

If Task 1 Step 11 settled on `npx wrangler dev` instead of `npm run preview`, say so in the "Working locally" list.

- [ ] **Step 13: Commit**

```bash
git add src/content.config.ts src/content/pages/home.md src/content/pages/about.md src/styles/site.css src/layouts/Base.astro src/pages/index.astro 'src/pages/[id].astro' src/pages/404.astro README.md
git commit -m "Add Markdown page collection, base layout and home, about and 404 pages"
```

---

### Task 4: Discord widget helpers (pure functions, TDD)

The deliverable is every piece of widget logic that can be wrong without a browser: URL building, invite-code extraction, animated-icon detection, the total-member fallback and the status label. The DOM work in Task 5 then has almost nothing left to get wrong. These are ported from `C:\Users\k430431\Local Projects\Claude\discord-widget\index.html`.

**Files:**
- Create: `src/lib/discord-widget.ts`
- Test: `test/discord-widget.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all from `src/lib/discord-widget.ts`:
  - `const DISCORD_GUILD_ID = '1210598510999633971'`
  - `type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'`
  - `interface WidgetMember { id: string; username: string; status?: string; avatar_url: string; game?: { name: string } }`
  - `interface WidgetResponse { id: string; name: string; instant_invite: string | null; presence_count: number; members?: WidgetMember[] }`
  - `interface InviteResponse { approximate_member_count?: number; profile?: { member_count?: number }; guild?: { icon?: string | null } }`
  - `widgetUrl(guildId: string): string`
  - `inviteUrl(code: string): string`
  - `inviteCodeFrom(instantInvite: string | null | undefined): string | null`
  - `guildIconUrl(guildId: string, hash: string): string`
  - `totalMemberCount(invite: InviteResponse): number | undefined`
  - `countsLabel(online: number, total?: number): string`
  - `statusClass(status: string | undefined): PresenceStatus`

- [ ] **Step 1: Write the failing tests for the URL helpers**

Create `test/discord-widget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DISCORD_GUILD_ID,
  widgetUrl,
  inviteUrl,
  inviteCodeFrom,
  guildIconUrl,
} from '../src/lib/discord-widget';

describe('DISCORD_GUILD_ID', () => {
  it('is the LahtiAG guild', () => {
    expect(DISCORD_GUILD_ID).toBe('1210598510999633971');
  });
});

describe('widgetUrl', () => {
  it('points at the public widget endpoint for the guild', () => {
    expect(widgetUrl('123')).toBe('https://discord.com/api/guilds/123/widget.json');
  });
});

describe('inviteUrl', () => {
  it('asks the invite endpoint for counts', () => {
    expect(inviteUrl('AbC123')).toBe('https://discord.com/api/v9/invites/AbC123?with_counts=true');
  });

  it('url-encodes the code', () => {
    expect(inviteUrl('a b')).toBe('https://discord.com/api/v9/invites/a%20b?with_counts=true');
  });
});

describe('inviteCodeFrom', () => {
  it('takes the last path segment of the instant invite', () => {
    expect(inviteCodeFrom('https://discord.gg/AbC123')).toBe('AbC123');
  });

  it('also handles the long invite form', () => {
    expect(inviteCodeFrom('https://discord.com/invite/AbC123')).toBe('AbC123');
  });

  it('drops a query string', () => {
    expect(inviteCodeFrom('https://discord.gg/AbC123?event=1')).toBe('AbC123');
  });

  it('returns null when the widget has no invite', () => {
    expect(inviteCodeFrom(null)).toBeNull();
    expect(inviteCodeFrom(undefined)).toBeNull();
    expect(inviteCodeFrom('https://discord.gg/')).toBeNull();
  });
});

describe('guildIconUrl', () => {
  it('uses png for a static icon hash', () => {
    expect(guildIconUrl('123', 'abc')).toBe('https://cdn.discordapp.com/icons/123/abc.png?size=128');
  });

  it('uses gif for an animated icon hash', () => {
    expect(guildIconUrl('123', 'a_abc')).toBe('https://cdn.discordapp.com/icons/123/a_abc.gif?size=128');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:

```bash
npx vitest run test/discord-widget.test.ts
```

Expected: FAIL resolving `../src/lib/discord-widget`.

- [ ] **Step 3: Implement the URL helpers**

Create `src/lib/discord-widget.ts`:

```ts
// Pure helpers for the Discord widget. Everything that touches the DOM lives
// in src/components/DiscordWidget.astro; everything that can be unit-tested
// lives here.

export const DISCORD_GUILD_ID = '1210598510999633971';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

// Shape of https://discord.com/api/guilds/{id}/widget.json. Members are
// online-only and capped at 100 by Discord. `game` is not in Discord's
// documented widget object but is present in real responses.
export interface WidgetMember {
  id: string;
  username: string;
  status?: string;
  avatar_url: string;
  game?: { name: string };
}

export interface WidgetResponse {
  id: string;
  name: string;
  instant_invite: string | null;
  presence_count: number;
  members?: WidgetMember[];
}

// Shape of https://discord.com/api/v9/invites/{code}?with_counts=true, only
// the fields the widget reads. The widget endpoint omits the server icon and
// the total member count; the invite endpoint carries both and allows CORS.
export interface InviteResponse {
  approximate_member_count?: number;
  profile?: { member_count?: number };
  guild?: { icon?: string | null };
}

export function widgetUrl(guildId: string): string {
  return `https://discord.com/api/guilds/${guildId}/widget.json`;
}

export function inviteUrl(code: string): string {
  return `https://discord.com/api/v9/invites/${encodeURIComponent(code)}?with_counts=true`;
}

// The invite code expires, so it is read from widget.json on every load and
// never hardcoded. Both https://discord.gg/CODE and
// https://discord.com/invite/CODE end in the code.
export function inviteCodeFrom(instantInvite: string | null | undefined): string | null {
  if (!instantInvite) return null;
  const lastSegment = instantInvite.split('/').pop() ?? '';
  const code = lastSegment.split('?')[0] ?? '';
  return code.length > 0 ? code : null;
}

// Animated icons have hashes prefixed `a_` and are served as gif.
export function guildIconUrl(guildId: string, hash: string): string {
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${extension}?size=128`;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run:

```bash
npx vitest run test/discord-widget.test.ts
```

Expected: `10 passed`.

- [ ] **Step 5: Append the failing tests for counts and status**

Append to `test/discord-widget.test.ts` (extend the import line first so it reads `import { DISCORD_GUILD_ID, widgetUrl, inviteUrl, inviteCodeFrom, guildIconUrl, totalMemberCount, countsLabel, statusClass } from '../src/lib/discord-widget';`):

```ts
describe('totalMemberCount', () => {
  it('prefers approximate_member_count', () => {
    expect(totalMemberCount({ approximate_member_count: 260, profile: { member_count: 1 } })).toBe(260);
  });

  it('falls back to profile.member_count', () => {
    expect(totalMemberCount({ profile: { member_count: 259 } })).toBe(259);
  });

  it('is undefined when neither is present', () => {
    expect(totalMemberCount({})).toBeUndefined();
  });
});

describe('countsLabel', () => {
  it('shows only the online count before the invite lookup', () => {
    expect(countsLabel(12)).toBe('12 online');
  });

  it('adds the total once known', () => {
    expect(countsLabel(12, 260)).toBe('12 online · 260 members');
  });

  it('treats a zero total as unknown', () => {
    expect(countsLabel(12, 0)).toBe('12 online');
  });
});

describe('statusClass', () => {
  it('passes through the three known presence values', () => {
    expect(statusClass('online')).toBe('online');
    expect(statusClass('idle')).toBe('idle');
    expect(statusClass('dnd')).toBe('dnd');
  });

  it('maps anything else to offline', () => {
    expect(statusClass('invisible')).toBe('offline');
    expect(statusClass(undefined)).toBe('offline');
  });
});
```

- [ ] **Step 6: Run and watch the new tests fail**

Run:

```bash
npx vitest run test/discord-widget.test.ts
```

Expected: the first 10 pass; the new ones fail with `totalMemberCount is not a function` (or an equivalent missing-export error).

- [ ] **Step 7: Implement counts and status**

Append to `src/lib/discord-widget.ts`:

```ts
// Discord has moved the total between two fields over time; read both.
export function totalMemberCount(invite: InviteResponse): number | undefined {
  return invite.approximate_member_count ?? invite.profile?.member_count;
}

// The middle dot separator matches the standalone widget's label.
export function countsLabel(online: number, total?: number): string {
  return total ? `${online} online · ${total} members` : `${online} online`;
}

export function statusClass(status: string | undefined): PresenceStatus {
  return status === 'online' || status === 'idle' || status === 'dnd' ? status : 'offline';
}
```

- [ ] **Step 8: Run the full suite**

Run:

```bash
npm test
```

Expected: `3 files`, `28 passed`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/discord-widget.ts test/discord-widget.test.ts
git commit -m "Add tested Discord widget helpers for urls, invite code, icon and counts"
```

---

### Task 5: Discord widget component on the Home page

The deliverable is the widget rendered natively on `/`: server name, icon, online and total counts, join button, avatar grid with status dots, loaded by the two-hop fetch. Discord's endpoints only make sense from a browser (CORS-enabled, signed single-use avatar URLs), so the DOM code is verified in a browser plus one `curl`, and the logic it calls was tested in Task 4.

**Files:**
- Create: `src/components/DiscordWidget.astro`
- Modify: `src/pages/index.astro` (add the component below the article)

**Interfaces:**
- Consumes: every export of `src/lib/discord-widget.ts` from Task 4; `Base.astro` and the `prose` class from Task 3.
- Produces: `<DiscordWidget guildId={string} />` with `guildId` optional and defaulting to `DISCORD_GUILD_ID`; root element `<section class="dw" data-guild-id="...">`.

- [ ] **Step 1: Create the component**

Create `src/components/DiscordWidget.astro`:

```astro
---
import { DISCORD_GUILD_ID } from '../lib/discord-widget';

interface Props {
  guildId?: string;
}

const { guildId = DISCORD_GUILD_ID } = Astro.props;
---
<section class="dw" data-guild-id={guildId} aria-label="LahtiAG on Discord">
  <div class="dw-header">
    <div class="dw-icon"></div>
    <div class="dw-meta">
      <p class="dw-name">Loading Discord widget</p>
      <p class="dw-counts"></p>
    </div>
    <a class="dw-join" target="_blank" rel="noopener" hidden>Join Server</a>
  </div>
  <div class="dw-members"></div>
  <p class="dw-intro">
    Our Discord is where we announce events, share updates and keep everyone
    informed about what is happening in the association.
  </p>
</section>

<!--
  is:global on purpose: Astro scopes component styles by stamping a data
  attribute onto elements in this template. Avatars are created by the script
  below at runtime and would not carry that attribute, so scoped rules would
  never reach them. All selectors are prefixed dw- to stay out of the way.
-->
<style is:global>
  .dw {
    margin-top: 2rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .dw p {
    margin: 0;
  }
  .dw-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
  }
  .dw-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    flex: 0 0 auto;
    background: var(--accent);
    overflow: hidden;
  }
  .dw-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .dw-meta {
    flex: 1 1 auto;
    min-width: 0;
  }
  .dw-name {
    font-weight: 600;
    font-size: 0.9375rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dw-counts {
    color: var(--muted);
  }
  .dw-counts b {
    color: #23a55a;
    font-weight: 400;
  }
  .dw-join {
    flex: 0 0 auto;
    padding: 9px 18px;
    background: var(--accent);
    color: #fff;
    text-decoration: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
  }
  .dw-join:hover {
    background: var(--accent-dark);
    color: #fff;
  }
  .dw-members {
    padding: 14px 16px;
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
  }
  .dw-members:empty {
    display: none;
  }
  .dw-avatar {
    position: relative;
    height: 38px;
  }
  .dw-avatar img {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    display: block;
    background: var(--line);
  }
  .dw-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--surface);
    background: #80848e;
  }
  .dw-dot.online {
    background: #23a55a;
  }
  .dw-dot.idle {
    background: #f0b232;
  }
  .dw-dot.dnd {
    background: #f23f43;
  }
  .dw-intro {
    padding: 10px 16px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.75rem;
  }
  @media (max-width: 420px) {
    .dw-header {
      padding: 10px 12px;
      gap: 10px;
    }
    .dw-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
    }
    .dw-join {
      padding: 7px 12px;
      font-size: 0.8125rem;
    }
  }
</style>

<script>
  import {
    DISCORD_GUILD_ID,
    widgetUrl,
    inviteUrl,
    inviteCodeFrom,
    guildIconUrl,
    totalMemberCount,
    countsLabel,
    statusClass,
  } from '../lib/discord-widget';
  import type { InviteResponse, WidgetResponse } from '../lib/discord-widget';

  async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return (await response.json()) as T;
  }

  function child<T extends HTMLElement>(root: HTMLElement, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`DiscordWidget: missing ${selector}`);
    return element;
  }

  function setCounts(target: HTMLElement, online: number, total?: number): void {
    const dot = document.createElement('b');
    dot.textContent = '●';
    target.replaceChildren(dot, ` ${countsLabel(online, total)}`);
  }

  async function load(root: HTMLElement): Promise<void> {
    const guildId = root.dataset.guildId || DISCORD_GUILD_ID;
    const nameEl = child(root, '.dw-name');
    const countsEl = child(root, '.dw-counts');
    const joinEl = child<HTMLAnchorElement>(root, '.dw-join');
    const membersEl = child(root, '.dw-members');
    const iconEl = child(root, '.dw-icon');

    // Hop 1: presence, member sample, server name and the current invite.
    const widget = await getJson<WidgetResponse>(widgetUrl(guildId));
    nameEl.textContent = widget.name;
    setCounts(countsEl, widget.presence_count);

    if (widget.instant_invite) {
      joinEl.href = widget.instant_invite;
      joinEl.hidden = false;
    }

    // Members are online-only and capped at 100 by Discord.
    for (const member of widget.members ?? []) {
      const avatar = document.createElement('div');
      avatar.className = 'dw-avatar';
      avatar.title = member.game ? `${member.username}, playing ${member.game.name}` : member.username;

      const img = document.createElement('img');
      img.src = member.avatar_url; // signed, single-use CDN url; never cache it
      img.alt = '';
      img.loading = 'lazy';

      const dot = document.createElement('span');
      dot.className = `dw-dot ${statusClass(member.status)}`;

      avatar.append(img, dot);
      membersEl.append(avatar);
    }

    // Hop 2: the widget endpoint omits the server icon and the total member
    // count; the invite endpoint carries both and allows CORS. The invite
    // code expires, so it is taken from hop 1 each load, never hardcoded.
    const code = inviteCodeFrom(widget.instant_invite);
    if (!code) return;
    const invite = await getJson<InviteResponse>(inviteUrl(code));

    const total = totalMemberCount(invite);
    if (total) setCounts(countsEl, widget.presence_count, total);

    const hash = invite.guild?.icon;
    if (!hash) return;
    const icon = document.createElement('img');
    icon.src = guildIconUrl(guildId, hash);
    icon.alt = '';
    iconEl.replaceChildren(icon);
  }

  for (const root of document.querySelectorAll<HTMLElement>('.dw')) {
    load(root).catch((error: unknown) => {
      console.error(error);
      child(root, '.dw-name').textContent = "Couldn't load the Discord widget";
    });
  }
</script>
```

Differences from the standalone widget, on purpose: the hover tooltip that positioned itself inside the card is replaced by the native `title` attribute (same information, no positioning code, no visual-design work in this phase); `document.title` is no longer changed because the page owns its title; the widget no longer fills its container's height because it sits in a page rather than an iframe.

- [ ] **Step 2: Place it on the Home page**

Modify `src/pages/index.astro`: add the import and the component so the file reads:

```astro
---
import { getEntry, render } from 'astro:content';
import Base from '../layouts/Base.astro';
import DiscordWidget from '../components/DiscordWidget.astro';

export const prerender = true;

const entry = await getEntry('pages', 'home');
if (!entry) {
  throw new Error('src/content/pages/home.md is required: it is the site root.');
}
const { Content } = await render(entry);
---
<Base title={entry.data.title} description={entry.data.description}>
  <article class="prose">
    <h1>{entry.data.title}</h1>
    <Content />
  </article>
  <DiscordWidget />
</Base>
```

- [ ] **Step 3: Build and confirm the markup and script shipped**

Run:

```bash
npm run build && grep -c 'data-guild-id="1210598510999633971"' dist/index.html && grep -c '<script' dist/index.html
```

Expected: build exits 0, then `1`, then a number of at least `1` (Astro either inlines the script or emits a `<script type="module" src=...>`; both are fine).

- [ ] **Step 4: Check it in a browser**

In a second terminal run `npm run preview` (or `npx wrangler dev`). Open the printed URL in a browser and confirm all of the following on the home page, below the article:

1. The name changes from "Loading Discord widget" to the server's name within a second or two.
2. The counts line reads like `● 12 online · 260 members` (the total appears a moment after the online count, because it comes from the second hop).
3. A square server icon replaces the plain accent-coloured block.
4. A "Join Server" button is visible and opens a `discord.gg` invite in a new tab.
5. A grid of round avatars with coloured status dots; hovering one shows a tooltip with the username.
6. In the browser DevTools Network tab, filtered to `discord.com`: exactly two requests, `widget.json` then `invites/<code>?with_counts=true`, both status 200.

If item 1 stays on "Loading" and the Console shows `widget.json -> 403`, the server widget has been disabled in Discord's Server Settings > Widget; enable it there (this is a Discord-side setting, not a code bug). If the total never appears, check the second request in the Network tab: a 404 means the invite from widget.json has expired between the two calls, which fixes itself on reload; anything else, read the error.

Stop the preview server.

- [ ] **Step 5: Run the checks**

Run:

```bash
npm run check && npm test
```

Expected: `0 errors` from check; `28 passed` from the tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/DiscordWidget.astro src/pages/index.astro
git commit -m "Port the Discord widget to an Astro component on the home page"
```

---

### Task 6: GitHub repository, first deploy, and Workers Builds on push to main

The deliverable is the site live on a `workers.dev` URL and redeploying itself whenever `main` changes. Nothing here is unit-testable; every step names the command or dashboard action and what proves it worked. Two values are produced and must be written down: `WORKERS_DEV_URL` (the Worker's public URL) and the Cloudflare account's dashboard location of the Worker.

**Files:**
- Create: `public/robots.txt` (the visible change that proves the push-to-deploy path)
- Modify: `README.md` (record `WORKERS_DEV_URL`)

**Interfaces:**
- Consumes: the Worker name `lahtiag-site` from `wrangler.toml` (Task 1); the `deploy` npm script (Task 1).
- Produces: GitHub repo `Valtterios/lahtiag-site` as `origin`; a deployed Worker named `lahtiag-site`; `WORKERS_DEV_URL`; a Workers Builds connection on branch `main` with build command `npm run build` and deploy command `npx wrangler deploy`.

- [ ] **Step 1: Make `gh` available in this shell and confirm the account**

Run (Git Bash):

```bash
export PATH="$LOCALAPPDATA/Programs/gh/bin:$PATH" && gh auth status
```

Expected: `Logged in to github.com account Valtterios`. In PowerShell: `$env:PATH = "$env:LOCALAPPDATA\Programs\gh\bin;$env:PATH"; gh auth status`.

- [ ] **Step 2: Create the GitHub repository and push**

Run from the repo root:

```bash
gh repo create Valtterios/lahtiag-site --private --source=. --remote=origin --push
```

Expected: `Created repository Valtterios/lahtiag-site on GitHub` and a push of `main`. Confirm:

```bash
git remote -v && git log --oneline origin/main | head -1
```

Expected: `origin` pointing at `https://github.com/Valtterios/lahtiag-site.git` and the latest commit hash matching your local `main`. The repo is private by default here; make it public later with `gh repo edit Valtterios/lahtiag-site --visibility public --accept-visibility-change-consequences` if the association wants members to open pull requests against the Markdown.

- [ ] **Step 3: Log Wrangler in to the Cloudflare account**

Run:

```bash
npx wrangler login
```

Expected: a browser window asks you to authorise Wrangler; the terminal then prints `Successfully logged in.` Confirm:

```bash
npx wrangler whoami
```

Expected: a table with the account name and id. If more than one account is listed, note the id of the one that holds the domain's DNS zone; it is the account the site must live in.

- [ ] **Step 4: First deploy from the laptop**

This creates the Worker so that Workers Builds has something to attach to, and proves `wrangler.toml` end to end before CI is involved.

Run:

```bash
npm run deploy
```

Expected: the Astro build output, then Wrangler lines including `Uploaded lahtiag-site`, `Deployed lahtiag-site triggers`, and a URL of the form `https://lahtiag-site.<subdomain>.workers.dev`. Record that URL as `WORKERS_DEV_URL`.

Verify: if Wrangler asks whether to register a `workers.dev` subdomain, answer yes. If no URL is printed at all, open the Cloudflare dashboard, Workers & Pages > `lahtiag-site` > Settings > Domains & Routes, and enable the `workers.dev` route; the URL is shown there. If the deploy fails with a message about more than one account, run `CLOUDFLARE_ACCOUNT_ID=<id from Step 3> npm run deploy`.

- [ ] **Step 5: Curl the deployed site**

Run, with the real URL in place of `WORKERS_DEV_URL`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' WORKERS_DEV_URL/
curl -s -o /dev/null -w '%{http_code}\n' WORKERS_DEV_URL/about
curl -s -o /dev/null -w '%{http_code}\n' WORKERS_DEV_URL/no-such-page
curl -s WORKERS_DEV_URL/ | grep -c 'data-guild-id'
```

Expected: `200`, `200`, `404`, `1`. Then open `WORKERS_DEV_URL` in a browser and confirm the Discord widget loads exactly as in Task 5 Step 4 (it is the browser talking to Discord, so this must work from the deployed origin too).

- [ ] **Step 6: Connect the repository to Workers Builds**

In the Cloudflare dashboard:

1. Go to **Workers & Pages**, open **lahtiag-site**.
2. Open **Settings**, then **Builds**, then **Connect**.
3. Choose **GitHub**. If this is the first time, GitHub asks you to install the "Cloudflare Workers & Pages" GitHub App on the `Valtterios` account; grant it access to the `lahtiag-site` repository (only that repository is needed).
4. Select repository `Valtterios/lahtiag-site`.
5. Build configuration:
   - Production branch: `main`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Non-production branch deploy command: leave the default `npx wrangler versions upload`
   - Root directory: `/` (leave empty)
   - Build variables: none
6. Save.

Expected: the Builds page shows the repository connected and a note that the next push to `main` will build. The Worker name (`lahtiag-site`) matches `name` in `wrangler.toml`, which Cloudflare requires for the build to succeed.

- [ ] **Step 7: Add `robots.txt` as a visible change**

Create `public/robots.txt` (anything under `public/` is copied verbatim into `dist/`):

```
User-agent: *
Allow: /
```

- [ ] **Step 8: Record the URL in the README**

Append to `README.md` under the "Deployment" heading:

```markdown
The Worker's direct URL is `WORKERS_DEV_URL` (replace with the real value).
It stays reachable after the custom domain is attached and is useful for
checking a deploy independently of DNS.
```

Replace `WORKERS_DEV_URL` in that text with the actual URL from Step 4 before committing.

- [ ] **Step 9: Push and watch the build**

Run:

```bash
git add public/robots.txt README.md
git commit -m "Add robots.txt and record the workers.dev url; first push-triggered deploy"
git push origin main
```

Then in the dashboard, Workers & Pages > lahtiag-site > **Deployments** (or **Builds**): a new build appears within a minute, shows the commit message above, runs `npm run build` then `npx wrangler deploy`, and ends in **Success**. Typical duration is one to three minutes.

- [ ] **Step 10: Prove the push deployed**

Run:

```bash
curl -s WORKERS_DEV_URL/robots.txt
```

Expected output, exactly:

```
User-agent: *
Allow: /
```

If it is `404`, the build has not finished or failed; open the build log. The most common failure is the Worker name mismatch (the log says so explicitly) or a Node version problem, which does not apply here because the Workers Builds default Node is 24.x and `package.json` requires only >= 22.12.

---

### Task 7: Attach the custom domain `SITE_DOMAIN`

The deliverable is the site answering on the association's domain, which is the moment it replaces Google Sites. The domain name is decided outside this plan; wherever this task says `SITE_DOMAIN`, use the literal hostname (for example the apex, without `https://` and without a trailing dot). The value goes in exactly two files, both listed below. This task can run any time after Task 6, and should run only when the association is ready for the cutover, because it takes the hostname away from Google Sites.

**Files:**
- Modify: `wrangler.toml` (append a `[[routes]]` block; this is where `SITE_DOMAIN` is written)
- Modify: `astro.config.mjs` (add `site`; the second place `SITE_DOMAIN` is written)

**Interfaces:**
- Consumes: the deployed Worker `lahtiag-site` and the Workers Builds connection from Task 6.
- Produces: `https://SITE_DOMAIN/` serving the site; `Astro.site` set, which later phases use to build absolute URLs (for example the OAuth callback URL).

- [ ] **Step 1: Confirm the zone is on this Cloudflare account and see what the hostname currently points at**

In the Cloudflare dashboard, open the zone for `SITE_DOMAIN` and its **DNS** records. Expected: the zone exists in the same account as the Worker (Task 6 Step 3). Note every DNS record whose name is exactly `SITE_DOMAIN`: with Google Sites there is typically a `CNAME` to `ghs.googlehosted.com`, or `A` records. Cloudflare refuses to create a Custom Domain on a hostname that already has a conflicting record, so these must go in Step 4.

From a terminal:

```bash
nslookup SITE_DOMAIN
```

Expected: whatever the current records resolve to; keep this output so you can see it change in Step 6.

- [ ] **Step 2: Write the domain into `wrangler.toml`**

Append to `wrangler.toml`:

```toml
# Custom domain. Wrangler creates the DNS record and the certificate on
# deploy. Keep this in config rather than the dashboard so a deploy from any
# machine reproduces it.
[[routes]]
pattern = "SITE_DOMAIN"
custom_domain = true
```

with the literal hostname in place of `SITE_DOMAIN`.

- [ ] **Step 3: Write the domain into `astro.config.mjs`**

Change the config to:

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://SITE_DOMAIN',
  output: 'server',
  adapter: cloudflare(),
});
```

with the literal hostname in place of `SITE_DOMAIN`. `site` is what Astro uses for canonical and absolute URLs; nothing in Phase 1 reads it yet, but setting it here means the domain is written in exactly two places and both are in one commit.

- [ ] **Step 4: Remove the old DNS records for the hostname**

In the zone's DNS page, delete every `A`, `AAAA` or `CNAME` record whose name is exactly `SITE_DOMAIN`. Leave `MX`, `TXT` and every other name (including `www`) untouched. From this moment until Step 5 completes, the hostname does not resolve to anything, so do Steps 4 and 5 back to back.

- [ ] **Step 5: Deploy the route**

Run:

```bash
git add wrangler.toml astro.config.mjs
git commit -m "Attach the custom domain to the lahtiag-site worker"
git push origin main
```

Expected: a Workers Builds run succeeds (Task 6 Step 9 shows where to watch). Its deploy log includes the domain under `Deployed lahtiag-site triggers`, and the zone's DNS page now shows a new record for `SITE_DOMAIN` labelled as a Worker custom domain.

Verify: if the build log says the hostname already has a DNS record, Step 4 missed one; delete it and re-run the build from the dashboard (Deployments > the failed build > Retry). If you would rather not wait for CI, `npm run deploy` from the laptop does the same thing.

- [ ] **Step 6: Prove the domain serves the site**

Run:

```bash
curl -sI https://SITE_DOMAIN/ | head -1
curl -s -o /dev/null -w '%{http_code}\n' https://SITE_DOMAIN/about
curl -s https://SITE_DOMAIN/robots.txt
```

Expected: `HTTP/2 200`, `200`, and the two-line robots.txt from Task 6. Certificate issuance can take a few minutes after the deploy; if the first command reports a TLS error, wait five minutes and retry before investigating. Then open `https://SITE_DOMAIN/` in a browser and confirm the Discord widget loads.

- [ ] **Step 7: Decide about `www`**

The spec says the Worker serves the apex domain and says nothing about `www`. Cloudflare Custom Domains match hostnames exactly, so `www.SITE_DOMAIN` does not serve the site unless added. If the association wants it, append a second block to `wrangler.toml`:

```toml
[[routes]]
pattern = "www.SITE_DOMAIN"
custom_domain = true
```

remove any existing `www` record first (as in Step 4), commit with the message `Serve the site on www as well as the apex`, and push. This serves the same site on both names without a redirect; a redirect rule is a later nicety, not Phase 1.

- [ ] **Step 8: Retire Google Sites**

In Google Sites, unpublish the old site or leave it published on its `sites.google.com` address; it no longer receives traffic on `SITE_DOMAIN` either way. The standalone widget at `valtterios.github.io/discord-widget` stays up until every embed of it is gone (spec: Deferred work).

---

## Self-review

**Spec coverage (Phase 1 items):** Markdown public pages edited in git (Task 3); single Worker with static assets, prerendered pages served from the edge (Tasks 1, 3); wrangler config (Task 1); Workers Builds from GitHub on push (Task 6); apex domain attachment (Task 7); Vitest inside the Workers runtime (Task 2); the Discord widget as a native component with the two-hop fetch and the expiring-invite reasoning (Tasks 4, 5); routes `/`, `/about` (Task 3). The spec's `/teams` static route is not created because its content is undefined; the maintainer adds `teams.md` when there is something to say, which is the whole point of Task 3.

**Not covered, by design (later phases):** D1 and the schema, sessions and cookie signing, Discord OAuth, `/events` and signups, teams and rosters, the interactions endpoint and slash commands, the webhook, `/api/v1/*`, migrations, preview-environment database separation, `DISCORD_GUILD_ID` and `ADMIN_ROLE_ID` as Worker vars (the guild id is a client-side constant in `src/lib/discord-widget.ts` until server code exists to read a var), all five "priority coverage" test areas (they test code that does not exist yet), and every secret.

**Placeholder scan:** the only intentionally unresolved values are `SITE_DOMAIN` and `WORKERS_DEV_URL`, both documented variables the brief requires; the Markdown prose is placeholder copy by decision, marked in-file. Every code step has full code.

**Type consistency:** `pageSchema`/`PageFrontmatter` (Task 2) are what `content.config.ts` (Task 3) imports; `navLinks`/`NavSource` (Task 2) accept the collection entries `Base.astro` passes (Task 3); every name in Task 5's script import list is exported by Task 4 with the signatures in Task 4's Interfaces block; the `dw` class names in Task 5's markup, stylesheet and script match; `prose`, `site-*` classes from Task 3 are the ones Task 5 relies on; the Worker name `lahtiag-site` is the same in Task 1, 6 and 7.

**Flagged uncertainties, each carrying a Verify note at the step:** the exact build output layout and whether `.wrangler/deploy/config.json` is generated (Task 1 Step 9); whether `astro preview` serves the build through workerd or `wrangler dev` must be used (Task 1 Step 11); whether the Vitest plugin accepts a config with no `main` (Task 2 Step 3) and whether `astro/zod` resolves inside it (Task 2 Step 5); the collection id derivation (Task 3 Step 9); the 404 path through the asset layer versus the Worker (Task 3 Step 10).
