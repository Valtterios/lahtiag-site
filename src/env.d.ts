// The Worker's environment: the two bindings plus the spec's secrets. The
// secrets are optional on purpose — routes degrade to a friendly "not
// configured" page instead of crashing when one is missing, so code can
// deploy before the Discord application exists.
//
// Workers types are pulled in via inline import() only: a global
// `/// <reference types="@cloudflare/workers-types" />` would clobber the
// DOM types the Discord widget's browser script needs (its Element/Response
// definitions collide with lib.dom).
type WorkerEnv = {
  DB: import('@cloudflare/workers-types').D1Database;
  ASSETS: import('@cloudflare/workers-types').Fetcher;
  ADMIN_ROLE_ID: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_WEBHOOK_URL?: string;
  // Board-only channel: new membership applications are announced here.
  BOARD_WEBHOOK_URL?: string;
  // The Google step-up in front of the member register (src/lib/board.ts).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Fixed allowlist of Workspace accounts for the register; more are
  // added on the register page itself.
  REGISTER_ADMINS: string;
  // Discord roles that mirror the register (src/lib/roles.ts). The bot
  // token is the only bot credential in the system and is used for
  // nothing but roles.
  DISCORD_BOT_TOKEN?: string;
  MEMBER_ROLE_ID: string;
  ACTIVES_ROLE_ID: string;
};

// Astro v6+ with @astrojs/cloudflare 14: request env is imported from
// 'cloudflare:workers' (Astro.locals.runtime.env was removed and throws),
// and the execution context lives at Astro.locals.cfContext.
declare module 'cloudflare:workers' {
  export const env: WorkerEnv;
}

declare namespace App {
  interface Locals {
    cfContext: import('@cloudflare/workers-types').ExecutionContext;
  }
}
