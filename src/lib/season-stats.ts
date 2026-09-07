// The board's view of a season's counting, nobody named: Discord messages
// and voice by week and by channel, Minecraft play time by week and by
// server, and how many of the people counted are linked members. The
// board reads it to see that the listener and the play-time sync count
// right before any rule of the season pass hangs on the numbers. One
// season at a time, the current one unless asked otherwise, so last
// season never blends into this one and next year's board reads the same
// page.
import type { D1Database } from '@cloudflare/workers-types';
import { helsinkiDay, seasonBounds, seasonStartYear, seasonYears } from './activity';
import { SERVERS } from './minecraft';

export interface SeasonTotals {
  messages: number;
  voice_minutes: number;
  people: number; // Discord accounts with anything counted
  members: number; // of those, linked current members
  minecraft_minutes: number;
  players: number; // UUIDs with play time
  linked_players: number; // of those, a member's own name
}

export interface WeekRow {
  week: string; // the Monday, 'YYYY-MM-DD'
  messages: number;
  voice_minutes: number;
  people: number;
  minecraft_minutes: number;
  players: number;
}

export interface ServerRow {
  server: string;
  label: string;
  minutes: number;
  players: number;
  linked: number;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The Monday on or before a day.
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
}

// Every week of the season so far, by its Monday, oldest first.
export function seasonWeeks(startYear: number, now: number): string[] {
  const { from, to } = seasonBounds(startYear, now);
  const out: string[] = [];
  for (const d = new Date(`${mondayOf(from)}T00:00:00Z`); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 7)) out.push(iso(d));
  return out;
}

// The seasons with anything counted, newest first: the picker's choices.
export async function availableSeasons(db: D1Database, now: number): Promise<number[]> {
  const row = await db
    .prepare(
      `SELECT MIN(day) AS day FROM (
         SELECT MIN(day) AS day FROM discord_activity
         UNION ALL SELECT MIN(day) FROM discord_channel_activity
         UNION ALL SELECT MIN(day) FROM minecraft_playtime
       )`,
    )
    .first<{ day: string | null }>();
  const tick = await db.prepare('SELECT MIN(given_at) AS at FROM ticks').first<{ at: number | null }>();
  let first = row?.day ?? null;
  if (tick?.at) {
    const day = helsinkiDay(tick.at);
    if (first === null || day < first) first = day;
  }
  return seasonYears(first, now);
}

// ?season=2026 → 2026 when it is a season on offer, else the current one.
export function pickSeason(raw: string | null, seasons: number[], now: number): number {
  const year = Number(raw);
  return raw !== null && /^\d{4}$/.test(raw) && seasons.includes(year) ? year : seasonStartYear(now);
}

export async function seasonTotals(db: D1Database, startYear: number, now: number): Promise<SeasonTotals> {
  const { from, to } = seasonBounds(startYear, now);
  const [discord, minecraft] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(SUM(a.messages), 0) AS messages, COALESCE(SUM(a.voice_minutes), 0) AS voice_minutes,
           COUNT(DISTINCT a.discord_id) AS people, COUNT(DISTINCT r.discord_id) AS members
         FROM discord_activity a
         LEFT JOIN register r ON r.discord_id = a.discord_id AND r.status = 'member'
         WHERE a.day BETWEEN ?1 AND ?2`,
      )
      .bind(from, to)
      .first<{ messages: number; voice_minutes: number; people: number; members: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(p.minutes), 0) AS minutes, COUNT(DISTINCT p.uuid) AS players,
           COUNT(DISTINCT n.uuid) AS linked
         FROM minecraft_playtime p
         LEFT JOIN minecraft_names n ON n.uuid = p.uuid AND n.kind = 'own'
         WHERE p.day BETWEEN ?1 AND ?2`,
      )
      .bind(from, to)
      .first<{ minutes: number; players: number; linked: number }>(),
  ]);
  return {
    messages: discord?.messages ?? 0,
    voice_minutes: discord?.voice_minutes ?? 0,
    people: discord?.people ?? 0,
    members: discord?.members ?? 0,
    minecraft_minutes: minecraft?.minutes ?? 0,
    players: minecraft?.players ?? 0,
    linked_players: minecraft?.linked ?? 0,
  };
}

// Every week of the season, zeros included, so a quiet week shows as one.
export async function weeklyStats(db: D1Database, startYear: number, now: number): Promise<WeekRow[]> {
  const { from, to } = seasonBounds(startYear, now);
  const [discord, minecraft] = await Promise.all([
    db
      .prepare(
        `SELECT date(day, 'weekday 0', '-6 days') AS week, SUM(messages) AS messages, SUM(voice_minutes) AS voice_minutes,
           COUNT(DISTINCT discord_id) AS people
         FROM discord_activity WHERE day BETWEEN ?1 AND ?2 GROUP BY week`,
      )
      .bind(from, to)
      .all<{ week: string; messages: number; voice_minutes: number; people: number }>(),
    db
      .prepare(
        `SELECT date(day, 'weekday 0', '-6 days') AS week, SUM(minutes) AS minutes, COUNT(DISTINCT uuid) AS players
         FROM minecraft_playtime WHERE day BETWEEN ?1 AND ?2 GROUP BY week`,
      )
      .bind(from, to)
      .all<{ week: string; minutes: number; players: number }>(),
  ]);
  const d = new Map(discord.results.map((r) => [r.week, r]));
  const m = new Map(minecraft.results.map((r) => [r.week, r]));
  return seasonWeeks(startYear, now).map((week) => ({
    week,
    messages: d.get(week)?.messages ?? 0,
    voice_minutes: d.get(week)?.voice_minutes ?? 0,
    people: d.get(week)?.people ?? 0,
    minecraft_minutes: m.get(week)?.minutes ?? 0,
    players: m.get(week)?.players ?? 0,
  }));
}

// Play time per server, in the servers' own order, zero included.
export async function serverStats(db: D1Database, startYear: number, now: number): Promise<ServerRow[]> {
  const { from, to } = seasonBounds(startYear, now);
  const { results } = await db
    .prepare(
      `SELECT p.server, SUM(p.minutes) AS minutes, COUNT(DISTINCT p.uuid) AS players, COUNT(DISTINCT n.uuid) AS linked
       FROM minecraft_playtime p
       LEFT JOIN minecraft_names n ON n.uuid = p.uuid AND n.kind = 'own'
       WHERE p.day BETWEEN ?1 AND ?2 GROUP BY p.server`,
    )
    .bind(from, to)
    .all<{ server: string; minutes: number; players: number; linked: number }>();
  const by = new Map(results.map((r) => [r.server, r]));
  return SERVERS.map((s) => ({
    server: s.slug,
    label: s.label,
    minutes: by.get(s.slug)?.minutes ?? 0,
    players: by.get(s.slug)?.players ?? 0,
    linked: by.get(s.slug)?.linked ?? 0,
  }));
}

// "7 Sep" for a week's Monday, for the table.
export function weekLabel(week: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${week}T00:00:00Z`));
}
