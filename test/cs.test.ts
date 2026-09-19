import { describe, it, expect } from 'vitest';
import { CS2_SERVERS, steamConnect, steamSpectate, consoleConnect } from '../src/lib/config';
import { resolveHost, resolveServers, connectUrl, spectateUrl, consoleCommand } from '../src/lib/gameservers';

// lahtiag.fi/cs: the page teams are pointed at to get onto the Counter-Strike
// servers. The links are the whole product, so they are what is checked.

const dnsReply = (ip: string) =>
  new Response(JSON.stringify({ Answer: [{ type: 5, data: 'x.lahtiag.fi' }, { type: 1, data: ip }] }), { status: 200 });

describe('the Counter-Strike servers', () => {
  it('lists both servers on their own ports', () => {
    expect(CS2_SERVERS).toHaveLength(2);
    const ports = CS2_SERVERS.map((s) => s.port);
    const gotv = CS2_SERVERS.map((s) => s.gotvPort);
    expect(new Set([...ports, ...gotv]).size).toBe(4);
  });

  it('gives every server a hostname rather than the home IP, which moves', () => {
    for (const server of CS2_SERVERS) {
      expect(server.host).toMatch(/^cs\d?\.lahtiag\.fi$/);
    }
  });
});

describe('resolveHost', () => {
  it('picks the A record out of a chain that starts with a CNAME', async () => {
    expect(await resolveHost('cs1.lahtiag.fi', async () => dnsReply('85.23.69.201'))).toBe('85.23.69.201');
  });

  it('gives up quietly when the lookup fails', async () => {
    expect(await resolveHost('cs1.lahtiag.fi', async () => new Response('nope', { status: 500 }))).toBeNull();
    expect(
      await resolveHost('cs1.lahtiag.fi', async () => {
        throw new Error('network');
      }),
    ).toBeNull();
  });
});

describe('resolveServers', () => {
  it('puts the resolved IP in the link, because Steam dislikes hostnames', async () => {
    const servers = await resolveServers(CS2_SERVERS, async () => dnsReply('85.23.69.201'));
    for (const server of servers) {
      expect(server.resolved).toBe(true);
      expect(connectUrl(server)).toBe(`steam://connect/85.23.69.201:${server.port}/${server.password}`);
    }
  });

  it('falls back to the hostname rather than breaking the page', async () => {
    const servers = await resolveServers(CS2_SERVERS, async () => new Response('', { status: 500 }));
    for (const server of servers) {
      expect(server.resolved).toBe(false);
      expect(connectUrl(server)).toContain(server.host);
    }
  });

  it('looks the shared hostname up once per distinct host', async () => {
    let calls = 0;
    await resolveServers(CS2_SERVERS, async () => {
      calls += 1;
      return dnsReply('85.23.69.201');
    });
    expect(calls).toBe(new Set(CS2_SERVERS.map((s) => s.host)).size);
  });

  it('keeps the memorable hostname in the console command', async () => {
    const servers = await resolveServers(CS2_SERVERS, async () => dnsReply('85.23.69.201'));
    for (const server of servers) {
      expect(consoleCommand(server)).toContain(`${server.host}:${server.port}`);
      expect(consoleCommand(server)).not.toContain('85.23.69.201');
    }
  });

  it('leaves the password off the GOTV link', async () => {
    const servers = await resolveServers(CS2_SERVERS, async () => dnsReply('85.23.69.201'));
    for (const server of servers) {
      expect(spectateUrl(server)).toBe(`steam://connect/85.23.69.201:${server.gotvPort}`);
      expect(spectateUrl(server)).not.toContain(server.password);
    }
  });
});

describe('the plain hostname link forms', () => {
  it('carries the password so one click is enough', () => {
    const [first] = CS2_SERVERS;
    expect(steamConnect(first)).toBe(`steam://connect/${first.host}:${first.port}/${first.password}`);
    expect(steamSpectate(first)).not.toContain(first.password);
  });

  it('sets the password before connecting, or the connect is refused', () => {
    for (const server of CS2_SERVERS) {
      const command = consoleConnect(server);
      expect(command.indexOf('password ')).toBeLessThan(command.indexOf('connect '));
    }
  });
});
