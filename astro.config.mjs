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
