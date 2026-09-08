// Discord activity per member and day (and per channel and day, for
// statistics): messages sent and minutes in voice on the LahtiAG server.
// The listener on auraserver (scripts/discord-listener) does the counting
// and posts batches to /api/discord/activity; this module validates and
// applies them, and adds a member's season up. Counts only, never a word
// of content. The season is the academic year, from 1 September (Helsinki
// time).
import type { D1Database } from '@cloudflare/workers-types';
import { setSetting } from './db';

export interface ActivityDelta {
  discord_id: string;
  day: string; // 'YYYY-MM-DD', Helsinki time
  messages: number;
  voice_minutes: number;
}

export interface ChannelDelta {
  channel_id: string;
  name: string;
  day: string;
  messages: number;
  voice_minutes: number;
}

// A channel the listener counts in: every member can see it.
export interface ActivityChannel {
  id: string;
  name: string;
  kind: 'text' | 'voice';
}

export interface ActivityBatch {
  instance: string;
  seq: number;
  deltas: ActivityDelta[];
  channel_deltas?: ChannelDelta[];
  channels?: ActivityChannel[];
}

export const MAX_DELTAS = 5000;
export const MAX_CHANNELS = 500;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
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
    if (typeof r.day !== 'string' || !DAY.test(r.day)) return null;
    if (messages === null || voice === null) return null;
    if (messages === 0 && voice === 0) continue;
    deltas.push({ discord_id: r.discord_id, day: r.day, messages, voice_minutes: voice });
  }
  const batch: ActivityBatch = { instance: o.instance, seq: o.seq, deltas };
  if (o.channel_deltas !== undefined) {
    if (!Array.isArray(o.channel_deltas) || o.channel_deltas.length > MAX_DELTAS) return null;
    const rows: ChannelDelta[] = [];
    for (const item of o.channel_deltas) {
      if (!item || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const messages = count(r.messages);
      const voice = count(r.voice_minutes);
      if (typeof r.channel_id !== 'string' || !SNOWFLAKE.test(r.channel_id)) return null;
      if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 100) return null;
      if (typeof r.day !== 'string' || !DAY.test(r.day)) return null;
      if (messages === null || voice === null) return null;
      if (messages === 0 && voice === 0) continue;
      rows.push({ channel_id: r.channel_id, name: r.name, day: r.day, messages, voice_minutes: voice });
    }
    batch.channel_deltas = rows;
  }
  if (o.channels !== undefined) {
    if (!Array.isArray(o.channels) || o.channels.length > MAX_CHANNELS) return null;
    const channels: ActivityChannel[] = [];
    for (const item of o.channels) {
      if (!item || typeof item !== 'object') return null;
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string' || !SNOWFLAKE.test(c.id)) return null;
      if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 100) return null;
      if (c.kind !== 'text' && c.kind !== 'voice') return null;
      channels.push({ id: c.id, name: c.name, kind: c.kind });
    }
    batch.channels = channels;
  }
  return batch;
}

// The counted channels, as the listener last reported them, kept in the
// settings table so the membership page can say where the counting happens.
export async function rememberActivityChannels(db: D1Database, channels: ActivityChannel[], now: number): Promise<boolean> {
  const value = JSON.stringify(channels);
  const current = await db.prepare("SELECT value FROM settings WHERE key = 'activity_channels'").first<{ value: string }>();
  if (current?.value === value) return false;
  await setSetting(db, 'activity_channels', value, 'listener', now);
  return true;
}

export async function activityChannels(db: D1Database): Promise<ActivityChannel[]> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'activity_channels'").first<{ value: string }>();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? (parsed as ActivityChannel[]) : [];
  } catch {
    return [];
  }
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
          `INSERT INTO discord_activity (discord_id, day, messages, voice_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(discord_id, day) DO UPDATE SET
             messages = messages + excluded.messages,
             voice_minutes = voice_minutes + excluded.voice_minutes,
             updated_at = excluded.updated_at`,
        )
        .bind(d.discord_id, d.day, d.messages, d.voice_minutes, now),
    ),
    ...(batch.channel_deltas ?? []).map((d) =>
      db
        .prepare(
          `INSERT INTO discord_channel_activity (channel_id, name, day, messages, voice_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(channel_id, day) DO UPDATE SET
             name = excluded.name,
             messages = messages + excluded.messages,
             voice_minutes = voice_minutes + excluded.voice_minutes,
             updated_at = excluded.updated_at`,
        )
        .bind(d.channel_id, d.name, d.day, d.messages, d.voice_minutes, now),
    ),
  ]);
  return { applied: batch.deltas.length + (batch.channel_deltas?.length ?? 0), duplicate: false };
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

// 'YYYY-MM-DD' in Helsinki time, the key the counts are stored under.
export function helsinkiDay(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSeconds * 1000));
}

// The season's first and last stored day so far: 1 September to today.
export function seasonDays(unixSeconds: number): { from: string; to: string } {
  return seasonBounds(seasonStartYear(unixSeconds), unixSeconds);
}

// Any season's days: 1 September of its first year to 31 August of the
// next, or to today while the season is still running. Past seasons stay
// readable this way, which is what keeps the season page useful next year.
export function seasonBounds(startYear: number, unixSeconds: number): { from: string; to: string } {
  const today = helsinkiDay(unixSeconds);
  const last = `${startYear + 1}-08-31`;
  return { from: `${startYear}-09-01`, to: today < last ? today : last };
}

// Every season with a day in [firstDay, now], newest first, by start year.
export function seasonYears(firstDay: string | null, unixSeconds: number): number[] {
  const current = seasonStartYear(unixSeconds);
  const firstYear = firstDay ? Number(firstDay.slice(0, 4)) - (Number(firstDay.slice(5, 7)) >= 9 ? 0 : 1) : current;
  const out: number[] = [];
  for (let y = current; y >= Math.min(firstYear, current); y--) out.push(y);
  return out;
}

// The academic year the moment belongs to, named by the year it started in.
export function seasonStartYear(unixSeconds: number): number {
  const { year, month } = helsinkiYearMonth(unixSeconds);
  return month >= 9 ? year : year - 1;
}

export function seasonLabel(unixSeconds: number): string {
  return seasonName(seasonStartYear(unixSeconds));
}

// '2026–27' for the season that started in 2026.
export function seasonName(startYear: number): string {
  return `${startYear}–${String(startYear + 1).slice(-2)}`;
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
  const { from, to } = seasonDays(unixSeconds);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(messages), 0) AS messages, COALESCE(SUM(voice_minutes), 0) AS voice_minutes
       FROM discord_activity WHERE discord_id = ?1 AND day BETWEEN ?2 AND ?3`,
    )
    .bind(discordId, from, to)
    .first<{ messages: number; voice_minutes: number }>();
  return { messages: row?.messages ?? 0, voice_minutes: row?.voice_minutes ?? 0 };
}

// A member's whole record on Discord, every season together: the figure
// their membership card carries, where one season would read as thin.
export async function lifetimeActivity(db: D1Database, discordId: string): Promise<{ messages: number; voice_minutes: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(messages), 0) AS messages, COALESCE(SUM(voice_minutes), 0) AS voice_minutes
       FROM discord_activity WHERE discord_id = ?1`,
    )
    .bind(discordId)
    .first<{ messages: number; voice_minutes: number }>();
  return { messages: row?.messages ?? 0, voice_minutes: row?.voice_minutes ?? 0 };
}

// A member's season by month, oldest first: what a monthly rule looks at.
export async function monthlyActivity(db: D1Database, discordId: string, unixSeconds: number): Promise<{ month: string; messages: number; voice_minutes: number }[]> {
  const { from, to } = seasonDays(unixSeconds);
  const { results } = await db
    .prepare(
      `SELECT substr(day, 1, 7) AS month, SUM(messages) AS messages, SUM(voice_minutes) AS voice_minutes
       FROM discord_activity WHERE discord_id = ?1 AND day BETWEEN ?2 AND ?3 GROUP BY month ORDER BY month`,
    )
    .bind(discordId, from, to)
    .all<{ month: string; messages: number; voice_minutes: number }>();
  return results;
}

// The season per channel, busiest first: the statistics side, no member in it.
export async function channelSeason(
  db: D1Database,
  unixSeconds: number,
  startYear = seasonStartYear(unixSeconds),
): Promise<{ channel_id: string; name: string; messages: number; voice_minutes: number; days: number }[]> {
  const { from, to } = seasonBounds(startYear, unixSeconds);
  const { results } = await db
    .prepare(
      `SELECT channel_id, name, SUM(messages) AS messages, SUM(voice_minutes) AS voice_minutes, COUNT(*) AS days
       FROM discord_channel_activity WHERE day BETWEEN ?1 AND ?2 GROUP BY channel_id ORDER BY messages + voice_minutes DESC, name`,
    )
    .bind(from, to)
    .all<{ channel_id: string; name: string; messages: number; voice_minutes: number; days: number }>();
  return results;
}

export function voiceLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}
