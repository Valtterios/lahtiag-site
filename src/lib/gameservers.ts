import { CS2_SERVERS, type GameServer } from './config';

// Resolving the servers' hostname to the address the steam:// link actually
// carries.
//
// Why bother: the Steam client's connect handler is reliable with a literal
// IP:port and flaky with a DNS name, so the link a visitor clicks should be
// the numeric one. The hostname still exists and is still what people are
// told to type — it is what survives the home connection getting a new IP —
// but the click-through resolves it first.
//
// The lookup is DNS-over-HTTPS because a Worker has no resolver of its own.
// If it fails for any reason the hostname goes into the link unchanged:
// a link that might not launch is better than a page that 500s on the
// evening of a tournament.

const DOH = 'https://cloudflare-dns.com/dns-query';

export interface ResolvedServer extends GameServer {
  // The literal IP when the lookup worked, the hostname when it did not.
  address: string;
  resolved: boolean;
}

export async function resolveHost(host: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`${DOH}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
    // type 1 is an A record; CNAMEs in the chain come back as type 5.
    const a = body.Answer?.find((entry) => entry.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(entry.data));
    return a?.data ?? null;
  } catch {
    return null;
  }
}

export async function resolveServers(
  servers: GameServer[] = CS2_SERVERS,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedServer[]> {
  // Both servers are the same machine behind the same home connection, so
  // one lookup answers for all of them.
  const hosts = new Map<string, string | null>();
  for (const host of new Set(servers.map((s) => s.host))) {
    hosts.set(host, await resolveHost(host, fetcher));
  }
  return servers.map((server) => {
    const ip = hosts.get(server.host) ?? null;
    return { ...server, address: ip ?? server.host, resolved: ip !== null };
  });
}

// The link forms, built against whatever address we ended up with.
export const connectUrl = (s: ResolvedServer) => `steam://connect/${s.address}:${s.port}/${s.password}`;

// The console commands keep the hostname: they are typed by a person, the
// hostname is the thing worth remembering, and the client resolves it fine.
export const consoleCommand = (s: ResolvedServer) => `password ${s.password}; connect ${s.host}:${s.port}`;

// GOTV is console-only, deliberately. steam://connect makes the Steam
// client look the address up in Steam's own records to work out which game
// it is, and a GOTV relay is not a registered game server — only the game
// port carries the login token. Steam therefore refuses with "app id
// specified by server is invalid" without ever contacting the server. The
// console `connect` dials the address directly and works.
export const gotvCommand = (s: ResolvedServer) => `connect ${s.host}:${s.gotvPort}`;
