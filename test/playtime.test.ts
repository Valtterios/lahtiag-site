import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parsePlaytimeBatch, applyPlaytimeBatch, prunePlaytimeBatches, seasonPlaytime, monthlyPlaytime } from '../src/lib/playtime';

const SEP = Date.UTC(2026, 8, 6, 12) / 1000;
const ID = '100000000000000001';
const AINO = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const FRIEND = '61699b2e-d327-4a01-9f1e-0ea8c3f06bc6';

describe('Minecraft play time', () => {
  it('accepts a batch for a known server and refuses the rest', () => {
    expect(parsePlaytimeBatch({ instance: 'a', seq: 1, server: 'creative', deltas: [] })).toBeNull();
    expect(parsePlaytimeBatch({ instance: 'a', seq: 1, server: 'smp', deltas: [{ uuid: 'nope', day: '2026-09-06', minutes: 5 }] })).toBeNull();
    expect(parsePlaytimeBatch({ instance: 'a', seq: 1, server: 'smp', deltas: [{ uuid: AINO, day: '2026-09-06', minutes: -5 }] })).toBeNull();
    expect(parsePlaytimeBatch({ instance: 'a', seq: 1, server: 'smp', deltas: [{ uuid: AINO.toUpperCase(), day: '2026-09-06', minutes: 5 }, { uuid: FRIEND, day: '2026-09-06', minutes: 0 }] })).toEqual({
      instance: 'a',
      seq: 1,
      server: 'smp',
      deltas: [{ uuid: AINO, day: '2026-09-06', minutes: 5 }],
    });
  });

  it("adds a member's own names up per server and month, once per batch", async () => {
    await env.DB.prepare("INSERT INTO minecraft_names (discord_id, name, kind, added_at, uuid, servers, approved_at, approved_by) VALUES (?1, 'AinoV', 'own', 1, ?2, 'smp,gtnh', 1, ?1)").bind(ID, AINO).run();
    await env.DB.prepare("INSERT INTO minecraft_names (discord_id, name, kind, added_at, uuid, servers, approved_at, approved_by) VALUES (?1, 'Pekka_K', 'friend', 1, ?2, 'smp,gtnh', 1, ?1)").bind(ID, FRIEND).run();
    const first = { instance: 'smp-host', seq: 1, server: 'smp' as const, deltas: [{ uuid: AINO, day: '2026-09-02', minutes: 50 }, { uuid: FRIEND, day: '2026-09-02', minutes: 200 }] };
    expect(await applyPlaytimeBatch(env.DB, first, SEP)).toEqual({ applied: 2, duplicate: false });
    expect(await applyPlaytimeBatch(env.DB, first, SEP)).toEqual({ applied: 0, duplicate: true });
    await applyPlaytimeBatch(env.DB, { instance: 'smp-host', seq: 2, server: 'smp', deltas: [{ uuid: AINO, day: '2026-09-06', minutes: 25 }, { uuid: AINO, day: '2026-08-30', minutes: 999 }] }, SEP);
    await applyPlaytimeBatch(env.DB, { instance: 'gtnh-host', seq: 1, server: 'gtnh', deltas: [{ uuid: AINO, day: '2026-09-05', minutes: 40 }] }, SEP);
    expect(await seasonPlaytime(env.DB, ID, SEP)).toEqual([
      { server: 'smp', label: 'SMP', minutes: 75 },
      { server: 'gtnh', label: 'GT:NH modpack', minutes: 40 },
    ]);
    expect(await monthlyPlaytime(env.DB, ID, SEP)).toEqual([
      { month: '2026-09', server: 'gtnh', minutes: 40 },
      { month: '2026-09', server: 'smp', minutes: 75 },
    ]);
    expect(await seasonPlaytime(env.DB, '100000000000000009', SEP)).toEqual([
      { server: 'smp', label: 'SMP', minutes: 0 },
      { server: 'gtnh', label: 'GT:NH modpack', minutes: 0 },
    ]);
    expect(await prunePlaytimeBatches(env.DB, SEP + 1)).toBe(3);
  });
});
