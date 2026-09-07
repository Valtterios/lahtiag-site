// Minecraft play time per player, server and day. Each server keeps its
// own player statistics (online ticks per player); the sync script on the
// host (scripts/minecraft/playtime-sync.py) samples them every few minutes
// and posts the minutes since the last sample to /api/minecraft/playtime,
// in batches applied once. A member's time is whatever was played under
// the UUIDs of their own whitelisted names.
import type { D1Database } from '@cloudflare/workers-types';
import { ALL_SERVERS, SERVERS, UUID, type ServerSlug } from './minecraft';
import { seasonDays } from './activity';

export interface PlaytimeDelta {
  uuid: string;
  day: string;
  minutes: number;
}

export interface PlaytimeBatch {
  instance: string;
  seq: number;
  server: ServerSlug;
  deltas: PlaytimeDelta[];
}

export const MAX_PLAYTIME_DELTAS = 5000;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

export function parsePlaytimeBatch(input: unknown): PlaytimeBatch | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (typeof o.instance !== 'string' || !INSTANCE.test(o.instance)) return null;
  if (typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 1) return null;
  if (typeof o.server !== 'string' || !(ALL_SERVERS as readonly string[]).includes(o.server)) return null;
  if (!Array.isArray(o.deltas) || o.deltas.length > MAX_PLAYTIME_DELTAS) return null;
  const deltas: PlaytimeDelta[] = [];
  for (const item of o.deltas) {
    if (!item || typeof item !== 'object') return null;
    const r = item as Record<string, unknown>;
    if (typeof r.uuid !== 'string' || !UUID.test(r.uuid.toLowerCase())) return null;
    if (typeof r.day !== 'string' || !DAY.test(r.day)) return null;
    if (typeof r.minutes !== 'number' || !Number.isInteger(r.minutes) || r.minutes < 0 || r.minutes > 100_000) return null;
    if (r.minutes === 0) continue;
    deltas.push({ uuid: r.uuid.toLowerCase(), day: r.day, minutes: r.minutes });
  }
  return { instance: o.instance, seq: o.seq, server: o.server as ServerSlug, deltas };
}

export async function applyPlaytimeBatch(db: D1Database, batch: PlaytimeBatch, now: number): Promise<{ applied: number; duplicate: boolean }> {
  const seen = await db.prepare('SELECT 1 AS x FROM minecraft_playtime_batches WHERE instance = ?1 AND seq = ?2').bind(batch.instance, batch.seq).first();
  if (seen) return { applied: 0, duplicate: true };
  await db.batch([
    db.prepare('INSERT INTO minecraft_playtime_batches (instance, seq, received_at) VALUES (?1, ?2, ?3)').bind(batch.instance, batch.seq, now),
    ...batch.deltas.map((d) =>
      db
        .prepare(
          `INSERT INTO minecraft_playtime (uuid, server, day, minutes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(uuid, server, day) DO UPDATE SET minutes = minutes + excluded.minutes, updated_at = excluded.updated_at`,
        )
        .bind(d.uuid, batch.server, d.day, d.minutes, now),
    ),
  ]);
  return { applied: batch.deltas.length, duplicate: false };
}

export async function prunePlaytimeBatches(db: D1Database, before: number): Promise<number> {
  const result = await db.prepare('DELETE FROM minecraft_playtime_batches WHERE received_at < ?1').bind(before).run();
  return result.meta.changes ?? 0;
}

// A member's season per server, in the servers' own order, zero included.
export async function seasonPlaytime(db: D1Database, discordId: string, unixSeconds: number): Promise<{ server: ServerSlug; label: string; minutes: number }[]> {
  const { from, to } = seasonDays(unixSeconds);
  const { results } = await db
    .prepare(
      `SELECT p.server, SUM(p.minutes) AS minutes
       FROM minecraft_playtime p
       JOIN minecraft_names n ON n.uuid = p.uuid AND n.kind = 'own' AND n.discord_id = ?1
       WHERE p.day BETWEEN ?2 AND ?3
       GROUP BY p.server`,
    )
    .bind(discordId, from, to)
    .all<{ server: string; minutes: number }>();
  const by = new Map(results.map((r) => [r.server, r.minutes]));
  return SERVERS.map((s) => ({ server: s.slug, label: s.label, minutes: by.get(s.slug) ?? 0 }));
}

// A member's season by month and server, oldest first: what a monthly rule looks at.
export async function monthlyPlaytime(db: D1Database, discordId: string, unixSeconds: number): Promise<{ month: string; server: string; minutes: number }[]> {
  const { from, to } = seasonDays(unixSeconds);
  const { results } = await db
    .prepare(
      `SELECT substr(p.day, 1, 7) AS month, p.server, SUM(p.minutes) AS minutes
       FROM minecraft_playtime p
       JOIN minecraft_names n ON n.uuid = p.uuid AND n.kind = 'own' AND n.discord_id = ?1
       WHERE p.day BETWEEN ?2 AND ?3
       GROUP BY month, p.server ORDER BY month, p.server`,
    )
    .bind(discordId, from, to)
    .all<{ month: string; server: string; minutes: number }>();
  return results;
}

// This season's play time per account, for the board's whitelist page:
// the minutes played under each UUID and the last day it was seen. Keyed
// by UUID, so a name with no UUID (added before the Mojang lookup) and a
// name nobody has played on are both simply missing.
export async function seasonPlaytimeByUuid(db: D1Database, unixSeconds: number): Promise<Map<string, { minutes: number; last: string }>> {
  const { from, to } = seasonDays(unixSeconds);
  const { results } = await db
    .prepare(
      `SELECT uuid, SUM(minutes) AS minutes, MAX(day) AS last
       FROM minecraft_playtime WHERE day BETWEEN ?1 AND ?2 GROUP BY uuid`,
    )
    .bind(from, to)
    .all<{ uuid: string; minutes: number; last: string }>();
  return new Map(results.map((r) => [r.uuid, { minutes: r.minutes, last: r.last }]));
}
