// Where each player is in the GT:NH modpack. The quest book has a chapter
// per tier (Tier 0 - Stone Age, Tier 0.5 - Steam, Tier 1 - LV, ... Tier 12
// - UIV); the bridge on the host reads how many quests of each chapter a
// player has completed from the server's own BetterQuesting files and
// posts the counts here as a snapshot (POST /api/minecraft/progress). The
// tier a player is "in" is decided here, from the counts: the highest
// chapter with TIER_SHARE of its quests done (at least one), so a stray
// quest from a later chapter does not move anyone up. Shown on the
// membership page's Minecraft tab and by /gtnh in Discord; the bridge
// announces a tier reached in the chat channel.
import type { D1Database } from '@cloudflare/workers-types';
import { ALL_SERVERS, UUID, type ServerSlug } from './minecraft';

export const GTNH_TIERS = [
  { key: 'stone', label: 'Stone Age', tier: 'Tier 0' },
  { key: 'steam', label: 'Steam', tier: 'Tier 0.5' },
  { key: 'lv', label: 'LV', tier: 'Tier 1' },
  { key: 'mv', label: 'MV', tier: 'Tier 2' },
  { key: 'hv', label: 'HV', tier: 'Tier 3' },
  { key: 'ev', label: 'EV', tier: 'Tier 4' },
  { key: 'iv', label: 'IV', tier: 'Tier 5' },
  { key: 'luv', label: 'LuV', tier: 'Tier 6' },
  { key: 'zpm', label: 'ZPM', tier: 'Tier 7' },
  { key: 'uv', label: 'UV', tier: 'Tier 8' },
  { key: 'uhv', label: 'UHV', tier: 'Tier 9' },
  { key: 'uev', label: 'UEV', tier: 'Tier 10' },
  { key: 'umv', label: 'UMV', tier: 'Tier 11' },
  { key: 'uiv', label: 'UIV', tier: 'Tier 12' },
] as const;
export type TierKey = (typeof GTNH_TIERS)[number]['key'];
const TIER_KEYS: string[] = GTNH_TIERS.map((t) => t.key);

// The share of a chapter's quests that puts a player in that tier.
export const TIER_SHARE = 0.1;
export const MAX_PROGRESS_PLAYERS = 500;

export type ProgressLines = Partial<Record<TierKey, { done: number; total: number }>>;

export interface PlayerProgress {
  uuid: string;
  name: string;
  lines: ProgressLines;
  quests_done: number;
  quests_total: number;
}

export interface ProgressBatch {
  server: ServerSlug;
  players: PlayerProgress[];
}

const NAME = /^[A-Za-z0-9_]{1,16}$/;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : null;
}

export function parseProgressBatch(input: unknown): ProgressBatch | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (typeof o.server !== 'string' || !(ALL_SERVERS as readonly string[]).includes(o.server)) return null;
  if (!Array.isArray(o.players) || o.players.length > MAX_PROGRESS_PLAYERS) return null;
  const players: PlayerProgress[] = [];
  for (const item of o.players) {
    if (!item || typeof item !== 'object') return null;
    const p = item as Record<string, unknown>;
    if (typeof p.uuid !== 'string' || !UUID.test(p.uuid.toLowerCase())) return null;
    if (typeof p.name !== 'string' || !NAME.test(p.name)) return null;
    if (!p.lines || typeof p.lines !== 'object') return null;
    const lines: ProgressLines = {};
    for (const [key, raw] of Object.entries(p.lines as Record<string, unknown>)) {
      if (!TIER_KEYS.includes(key)) continue; // a chapter the ladder does not know is nothing to us
      if (!raw || typeof raw !== 'object') return null;
      const done = count((raw as Record<string, unknown>).done);
      const total = count((raw as Record<string, unknown>).total);
      if (done === null || total === null || done > total) return null;
      lines[key as TierKey] = { done, total };
    }
    const done = count(p.quests_done);
    const total = count(p.quests_total);
    if (done === null || total === null) return null;
    players.push({ uuid: p.uuid.toLowerCase(), name: p.name, lines, quests_done: done, quests_total: total });
  }
  return { server: o.server as ServerSlug, players };
}

// The highest tier whose chapter is far enough along, or null before the
// first quest. Order is the ladder's, not the count's: a lone HV quest
// with nothing in MV leaves a player in LV.
export function tierOf(lines: ProgressLines): TierKey | null {
  let reached: TierKey | null = null;
  for (const t of GTNH_TIERS) {
    const line = lines[t.key];
    if (!line || line.total === 0) continue;
    if (line.done >= Math.max(1, Math.ceil(line.total * TIER_SHARE))) reached = t.key;
  }
  return reached;
}

export function tierIndex(key: string | null): number {
  return key ? TIER_KEYS.indexOf(key) : -1;
}

export function tierInfo(key: string | null): (typeof GTNH_TIERS)[number] | null {
  return GTNH_TIERS.find((t) => t.key === key) ?? null;
}

// "HV (Tier 3)", or what a player with no quest yet is.
export function tierLabel(key: string | null): string {
  const t = tierInfo(key);
  return t ? `${t.label} (${t.tier})` : 'Not started';
}

// The next chapter on the ladder and how far along it is: "14 of 115 HV quests".
export function nextLine(lines: ProgressLines, tier: string | null): string | null {
  const next = GTNH_TIERS[tierIndex(tier) + 1];
  if (!next) return null;
  const line = lines[next.key];
  if (!line) return null;
  return `${line.done} of ${line.total} ${next.label} quests`;
}

export interface ProgressRow {
  uuid: string;
  server: ServerSlug;
  name: string;
  tier: TierKey | null;
  tier_since: number | null;
  lines: ProgressLines;
  quests_done: number;
  quests_total: number;
  updated_at: number;
}

function rowOf(r: Record<string, unknown>): ProgressRow {
  let lines: ProgressLines = {};
  try {
    lines = JSON.parse(String(r.lines)) as ProgressLines;
  } catch {
    lines = {};
  }
  return {
    uuid: String(r.uuid),
    server: r.server as ServerSlug,
    name: String(r.name),
    tier: (r.tier as TierKey | null) ?? null,
    tier_since: (r.tier_since as number | null) ?? null,
    lines,
    quests_done: Number(r.quests_done),
    quests_total: Number(r.quests_total),
    updated_at: Number(r.updated_at),
  };
}

// Applies a snapshot: every player in it is written, the rest are left as
// they were (the bridge sends the players whose files changed). Answers
// each player's tier, and whether it is higher than the one stored, so
// the bridge can say so in the chat channel.
export async function applyProgressBatch(
  db: D1Database,
  batch: ProgressBatch,
  now: number,
): Promise<{ applied: number; tiers: Record<string, { tier: TierKey | null; label: string; up: boolean }> }> {
  const tiers: Record<string, { tier: TierKey | null; label: string; up: boolean }> = {};
  if (batch.players.length === 0) return { applied: 0, tiers };
  const { results } = await db
    .prepare(`SELECT uuid, tier, tier_since FROM minecraft_progress WHERE server = ?1 AND uuid IN (${batch.players.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(batch.server, ...batch.players.map((p) => p.uuid))
    .all<{ uuid: string; tier: string | null; tier_since: number | null }>();
  const before = new Map(results.map((r) => [r.uuid, r]));
  const statements = batch.players.map((p) => {
    const tier = tierOf(p.lines);
    const old = before.get(p.uuid);
    const up = tierIndex(tier) > tierIndex(old?.tier ?? null);
    const since = tier === null ? null : old && old.tier === tier ? old.tier_since : now;
    tiers[p.uuid] = { tier, label: tierLabel(tier), up: Boolean(old) && up };
    return db
      .prepare(
        `INSERT INTO minecraft_progress (uuid, server, name, tier, tier_since, lines, quests_done, quests_total, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(uuid, server) DO UPDATE SET name = excluded.name, tier = excluded.tier, tier_since = excluded.tier_since,
           lines = excluded.lines, quests_done = excluded.quests_done, quests_total = excluded.quests_total, updated_at = excluded.updated_at`,
      )
      .bind(p.uuid, batch.server, p.name, tier, since, JSON.stringify(p.lines), p.quests_done, p.quests_total, now);
  });
  await db.batch(statements);
  return { applied: batch.players.length, tiers };
}

// Every player on a server, the furthest first; ties by quests done.
export async function progressBoard(db: D1Database, server: ServerSlug = 'gtnh'): Promise<ProgressRow[]> {
  const { results } = await db.prepare('SELECT * FROM minecraft_progress WHERE server = ?1').bind(server).all<Record<string, unknown>>();
  return results.map(rowOf).sort((a, b) => tierIndex(b.tier) - tierIndex(a.tier) || b.quests_done - a.quests_done || a.name.localeCompare(b.name));
}

// The progress under given UUIDs (a member's own names and friends), by UUID.
export async function progressByUuid(db: D1Database, uuids: string[], server: ServerSlug = 'gtnh'): Promise<Map<string, ProgressRow>> {
  const wanted = uuids.filter((u) => UUID.test(u));
  if (wanted.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT * FROM minecraft_progress WHERE server = ?1 AND uuid IN (${wanted.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(server, ...wanted)
    .all<Record<string, unknown>>();
  return new Map(results.map((r) => [String(r.uuid), rowOf(r)]));
}

// One player's line: "HV (Tier 3) · 412 quests · 14 of 115 EV quests".
export function progressLine(row: ProgressRow): string {
  const parts = [tierLabel(row.tier), `${row.quests_done} quests`];
  const next = nextLine(row.lines, row.tier);
  if (next) parts.push(next);
  return parts.join(' · ');
}

// The /gtnh board in Discord: every player's tier, the furthest first.
export function progressBoardLines(rows: ProgressRow[]): string {
  if (rows.length === 0) return '⚙️ **GT:NH progress** · nobody has opened the quest book yet.';
  const medal = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '▫️');
  return [
    `⚙️ **GT:NH progress** · ${rows.length} player${rows.length === 1 ? '' : 's'}`,
    ...rows.map((r, i) => `${medal(i)} **${r.name}** · ${progressLine(r)}`),
    '-# A tier counts once a tenth of its chapter is done. `/gtnh` shows this again.',
  ].join('\n');
}
