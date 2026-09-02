import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// output: 'server' is the spec's "Astro in SSR mode". Every Phase 1 page
// opts back into static output with `export const prerender = true`, so
// the Worker itself only ever renders the 404 page. Later phases add
// server routes by simply not exporting prerender.
export default defineConfig({
  // Canonical origin. Later phases build absolute URLs from this (e.g. the
  // Discord OAuth callback), so it must match the [[routes]] custom domain
  // in wrangler.toml.
  site: 'https://lahtiag.fi',
  output: 'server',
  // The spec's Architecture section says "No KV, R2 or Durable Objects.
  // Sessions are stateless"; auth in a later phase uses HMAC-signed cookies
  // with no server-side store. @astrojs/cloudflare enables KV-backed
  // sessions by default, which would provision an unused KV namespace on
  // first deploy. Do not re-enable this without revisiting that constraint.
  session: false,
  adapter: cloudflare({
    // The site has no images, so the default Cloudflare Images setup (an
    // `IMAGES` binding plus ~24 KiB of image-transform code in the Worker)
    // is pure dead weight. `passthrough` disables it, keeping the Worker
    // free of bindings it does not use, same reasoning as `session: false`
    // above.
    imageService: 'passthrough',
  }),
});
