// Build-time constants shared across the app. `DISCORD_GUILD_ID` is
// deliberately a build-time constant baked into the Worker bundle, not a
// Cloudflare Worker var (no `[vars]` entry in wrangler.toml). The design
// spec (docs/superpowers/specs/2026-09-02-lahtiag-website-design.md)
// requires later server code to read the same constant this widget already
// uses; importing it from here rather than reintroducing it as a `[vars]`
// entry keeps there being exactly one definition.
export const DISCORD_GUILD_ID = '1210598510999633971';
