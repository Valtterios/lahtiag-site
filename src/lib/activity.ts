// Discord activity per member and month: messages sent and minutes in
// voice on the LahtiAG server. The listener on auraserver
// (scripts/discord-listener) does the counting and posts batches to
// /api/discord/activity; this module validates and applies them, and adds
// a member's season up. Counts only, never a word of content. The season
// is the academic year, from 1 September (Helsinki time).
import type { D1Database } from '@cloudflare/workers-types';

export interface ActivityDelta {
  discord_id: string;
  month: string; // 'YYYY-MM'
  messages: number;
  voice_minutes: number;
}

export interface ActivityBatch {
  instance: string;
  seq: number;
  deltas: ActivityDelta[];
}

export const MAX_DELTAS = 5000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SNOWFLAKE = /^\d{17,20}$/;
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;
const TZ = 'Europe/Helsinki';

function count(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

// A batch as the listener posts it, or null for anything malformed. Rows
// with nothing to add are dropped.
export function parseActivityBatch(input: unknown): ActivityBatch | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (typeof o.instance !== 'string' || !INSTANCE.test(o.instance)) return null;
  if (typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 1) return null;
  if (!Array.isArray(o.deltas) || o.deltas.length > MAX_DELTAS) return null;
  const deltas: ActivityDelta[] = [];
  for (const item of o.deltas) {
    if (!item || typeof item !== 'object') return null;
    const r = item as Record<string, unknown>;
    const messages = count(r.messages);
    const voice = count(r.voice_minutes);
    if (typeof r.discord_id !== 'string' || !SNOWFLAKE.test(r.discord_id)) return null;
    if (typeof r.month !== 'string' || !MONTH.test(r.month)) return null;
    if (messages === null || voice === null) return null;
    if (messages === 0 && voice === 0) continue;
    deltas.push({ discord_id: r.discord_id, month: r.month, messages, voice_minutes: voice });
  }
  return { instance: o.instance, seq: o.seq, deltas };
}

// Adds the batch to the counts, once: the (instance, seq) pair is recorded
// in the same transaction, and a batch seen before is reported back as a
// duplicate without touching anything.
export async function applyActivityBatch(
  db: D1Database,
  batch: ActivityBatch,
  now: number,
): Promise<{ applied: number; duplicate: boolean }> {
  const seen = await db
    .prepare('SELECT 1 AS x FROM discord_activity_batches WHERE instance = ?1 AND seq = ?2')
    .bind(batch.instance, batch.seq)
    .first();
  if (seen) return { applied: 0, duplicate: true };
  await db.batch([
    db.prepare('INSERT INTO discord_activity_batches (instance, seq, received_at) VALUES (?1, ?2, ?3)').bind(batch.instance, batch.seq, now),
    ...batch.deltas.map((d) =>
      db
        .prepare(
          `INSERT INTO discord_activity (discord_id, month, messages, voice_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(discord_id, month) DO UPDATE SET
             messages = messages + excluded.messages,
             voice_minutes = voice_minutes + excluded.voice_minutes,
             updated_at = excluded.updated_at`,
        )
        .bind(d.discord_id, d.month, d.messages, d.voice_minutes, now),
    ),
  ]);
  return { applied: batch.deltas.length, duplicate: false };
}

export async function pruneActivityBatches(db: D1Database, before: number): Promise<number> {
  const result = await db.prepare('DELETE FROM discord_activity_batches WHERE received_at < ?1').bind(before).run();
  return result.meta.changes ?? 0;
}

// --- the season -----------------------------------------------------------------

export function helsinkiYearMonth(unixSeconds: number): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: 'numeric' }).formatToParts(new Date(unixSeconds * 1000));
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  return { year, month };
}

// The academic year the moment belongs to, named by the year it started in.
export function seasonStartYear(unixSeconds: number): number {
  const { year, month } = helsinkiYearMonth(unixSeconds);
  return month >= 9 ? year : year - 1;
}

export function seasonLabel(unixSeconds: number): string {
  const start = seasonStartYear(unixSeconds);
  return `${start}–${String(start + 1).slice(-2)}`;
}

// Every month of the season so far, September first.
export function seasonMonths(unixSeconds: number): string[] {
  const start = seasonStartYear(unixSeconds);
  const { year, month } = helsinkiYearMonth(unixSeconds);
  const out: string[] = [];
  let y = start;
  let m = 9;
  while (y < year || (y === year && m <= month)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export async function seasonActivity(db: D1Database, discordId: string, unixSeconds: number): Promise<{ messages: number; voice_minutes: number }> {
  const months = seasonMonths(unixSeconds);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(messages), 0) AS messages, COALESCE(SUM(voice_minutes), 0) AS voice_minutes
       FROM discord_activity WHERE discord_id = ?1 AND month IN (${months.map((_, i) => `?${i + 2}`).join(', ')})`,
    )
    .bind(discordId, ...months)
    .first<{ messages: number; voice_minutes: number }>();
  return { messages: row?.messages ?? 0, voice_minutes: row?.voice_minutes ?? 0 };
}

export function voiceLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}
