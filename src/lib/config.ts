// Build-time constants shared across the app. `DISCORD_GUILD_ID` is
// deliberately a build-time constant baked into the Worker bundle, not a
// Cloudflare Worker var (no `[vars]` entry in wrangler.toml). The design
// spec (docs/superpowers/specs/2026-09-02-lahtiag-website-design.md)
// requires later server code to read the same constant this widget already
// uses; importing it from here rather than reintroducing it as a `[vars]`
// entry keeps there being exactly one definition.
export const DISCORD_GUILD_ID = '1210598510999633971';
// The public address, for links made outside a request (the hourly job).
export const SITE_ORIGIN = 'https://lahtiag.fi';

// The server's public invite. One definition: the footer links it, and
// lahtiag.fi/dc redirects to it — the address to say out loud, since it
// fits on a poster and in a sentence.
export const DISCORD_INVITE = 'https://discord.com/invite/u2pcgDhQ7G';
