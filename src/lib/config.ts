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

// The Counter-Strike 2 tournament servers, behind lahtiag.fi/cs. One
// definition: the page renders these and the tests check them.
//
// `password` is sv_password on the server and is baked into the steam://
// link, because one click straight into the right server is the whole
// point of having the page. That makes it as public as the page is — the
// real gate on a tournament server is MatchZy's whitelist, not this.
// Change it here and on both servers together (AMP → the instance →
// Configuration → sv_password).
export interface GameServer {
  label: string;
  host: string;
  port: number;
  gotvPort: number;
  password: string;
}

export const CS2_SERVERS: GameServer[] = [
  { label: 'Server 1', host: 'cs1.lahtiag.fi', port: 27015, gotvPort: 27020, password: 'lagtournament' },
  { label: 'Server 2', host: 'cs2.lahtiag.fi', port: 27016, gotvPort: 27021, password: 'lagtournament' },
];

// steam://connect hands the address to an already-running CS2, or starts it
// first. The password is the third path segment; without it the client
// connects and is dropped for a bad password.
export function steamConnect(server: GameServer): string {
  return `steam://connect/${server.host}:${server.port}/${server.password}`;
}

// GOTV takes no password: spectators and casters get in with the address.
export function steamSpectate(server: GameServer): string {
  return `steam://connect/${server.host}:${server.gotvPort}`;
}

// What to paste into the CS2 console when a steam:// link does not survive
// the client it was posted in. `password` must be set before `connect`.
export function consoleConnect(server: GameServer): string {
  return `password ${server.password}; connect ${server.host}:${server.port}`;
}
