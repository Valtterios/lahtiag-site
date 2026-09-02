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
