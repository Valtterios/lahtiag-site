import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Tests run inside workerd, the Workers runtime, not Node. The runtime is
// configured inline instead of from wrangler.toml: that file's `main` is the
// Astro adapter entrypoint, which only resolves inside an Astro build and
// would fail to load here. The D1 binding mirrors production's `DB`; the
// real migrations are read here in Node and applied inside the runtime by
// test/setup.ts, so tests exercise the exact production schema.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'lahtiag-test' },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('migrations'),
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
}));
