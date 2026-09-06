// The Worker's own entry: Astro handles requests as before, and the
// hourly Cron Trigger (wrangler.toml) runs the reminders and the rest of
// src/lib/cron.ts. wrangler.toml's `main` points here; the adapter builds
// it as the server entry.

import { handle } from '@astrojs/cloudflare/handler';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { runHourly } from './lib/cron';
import { SITE_ORIGIN } from './lib/config';

type Env = {
  DB: import('@cloudflare/workers-types').D1Database;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_WEBHOOK_URL?: string;
};

export default {
  fetch: handle,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = Math.floor(controller.scheduledTime / 1000);
    ctx.waitUntil(
      runHourly(env.DB, env, SITE_ORIGIN, now)
        .then((summary) => console.log(`cron hourly: ${JSON.stringify(summary)}`))
        .catch((error: unknown) => console.error(`cron hourly failed: ${String(error)}`)),
    );
  },
};
