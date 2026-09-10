// The season pass: the levels the board sets for a season, where a
// member stands on them, and the moment someone reaches a new one. The
// XP is the season's XP (src/lib/xp.ts), so whatever joins that later
// (events, Discord, Minecraft) lands on the same track without this
// file changing. Reaching a level is written to a ledger once, and the
// hourly job (src/lib/cron.ts) tells the server and gives the reward
// from the ledger; nothing is ever announced twice, and a level once
// reached is never taken back.
import type { D1Database } from '@cloudflare/workers-types';
import { RuleError } from './db';
import { xpStandings, shownName, type Standing } from './xp';
import { seasonName, seasonStartYear } from './activity';
import { DISCORD_GUILD_ID } from './config';
import { dmUser, postWebhook, setGuildMemberRole, NO_MENTIONS, SUPPRESS_EMBEDS } from './discord';

export interface PassLevel {
  id: number;
  season_year: number;
  level: number;
  xp: number;
  name: string;
  reward: string;
  sponsor: string | null;
  role_id: string | null;
  reached: number; // members who have reached it, for the board and the reports
}

export interface PassLevelInput {
  xp?: unknown;
  name?: unknown;
  reward?: unknown;
  sponsor?: unknown;
  role_id?: unknown;
}

export const PASS_LIMITS = { name: 40, reward: 120, sponsor: 60, xp: 100_000, levels: 20 } as const;

const LEVEL_COLUMNS = `l.id, l.season_year, l.level, l.xp, l.name, l.reward, l.sponsor, l.role_id,
  (SELECT COUNT(*) FROM pass_reached r WHERE r.level_id = l.id) AS reached`;

// A season's levels, lowest first. Level numbers follow the XP order, so
// they are renumbered whenever the list changes rather than typed in.
export async function listPassLevels(db: D1Database, seasonYear: number): Promise<PassLevel[]> {
  const { results } = await db
    .prepare(`SELECT ${LEVEL_COLUMNS} FROM pass_levels l WHERE l.season_year = ?1 ORDER BY l.xp, l.level`)
    .bind(seasonYear)
    .all<PassLevel>();
  return results;
}

function clean(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
}

function validLevel(input: PassLevelInput): { xp: number; name: string; reward: string; sponsor: string | null; role_id: string | null } {
  const name = clean(input.name, PASS_LIMITS.name);
  const reward = clean(input.reward, PASS_LIMITS.reward);
  const sponsor = clean(input.sponsor, PASS_LIMITS.sponsor);
  const role = clean(input.role_id, 32);
  const xp = Number(String(input.xp ?? '').trim());
  if (name.length < 2 || name.length > PASS_LIMITS.name) throw new RuleError('bad_input', `A level needs a name of 2 to ${PASS_LIMITS.name} characters.`);
  if (reward.length < 2 || reward.length > PASS_LIMITS.reward) throw new RuleError('bad_input', 'Say what the reward is.');
  if (sponsor.length > PASS_LIMITS.sponsor) throw new RuleError('bad_input', 'The sponsor name is too long.');
  if (!Number.isInteger(xp) || xp < 1 || xp > PASS_LIMITS.xp) throw new RuleError('bad_input', `The XP is a whole number from 1 to ${PASS_LIMITS.xp}.`);
  if (role !== '' && !/^\d{17,20}$/.test(role)) throw new RuleError('bad_input', 'A Discord role id is 17 to 20 digits.');
  return { xp, name, reward, sponsor: sponsor === '' ? null : sponsor, role_id: role === '' ? null : role };
}

// After any change the levels are numbered 1… in XP order, so the
// number on the page and in the announcement is always the rung.
async function renumber(db: D1Database, seasonYear: number): Promise<void> {
  const { results } = await db
    .prepare('SELECT id FROM pass_levels WHERE season_year = ?1 ORDER BY xp, level, id')
    .bind(seasonYear)
    .all<{ id: number }>();
  // Two passes: SQLite checks the unique index row by row, so go through
  // numbers no level holds first.
  const statements = results.map((r, i) => db.prepare('UPDATE pass_levels SET level = ?2 WHERE id = ?1').bind(r.id, -(i + 1)));
  statements.push(...results.map((r, i) => db.prepare('UPDATE pass_levels SET level = ?2 WHERE id = ?1').bind(r.id, i + 1)));
  if (statements.length > 0) await db.batch(statements);
}

export async function addPassLevel(db: D1Database, seasonYear: number, input: PassLevelInput, by: string, now: number): Promise<PassLevel> {
  const level = validLevel(input);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM pass_levels WHERE season_year = ?1').bind(seasonYear).first<{ n: number }>();
  if ((count?.n ?? 0) >= PASS_LIMITS.levels) throw new RuleError('bad_input', `A season has at most ${PASS_LIMITS.levels} levels.`);
  const same = await db.prepare('SELECT id FROM pass_levels WHERE season_year = ?1 AND xp = ?2').bind(seasonYear, level.xp).first();
  if (same) throw new RuleError('duplicate', 'A level at that XP is already there.');
  const result = await db
    .prepare(
      `INSERT INTO pass_levels (season_year, level, xp, name, reward, sponsor, role_id, created_by, created_at, updated_at)
       VALUES (?1, (SELECT COALESCE(MAX(level), 0) + 1 FROM pass_levels WHERE season_year = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
    .bind(seasonYear, level.xp, level.name, level.reward, level.sponsor, level.role_id, by, now)
    .run();
  await renumber(db, seasonYear);
  const row = await getPassLevel(db, Number(result.meta.last_row_id));
  if (!row) throw new RuleError('missing', 'The level was not saved.');
  return row;
}

export async function getPassLevel(db: D1Database, id: number): Promise<PassLevel | null> {
  return db.prepare(`SELECT ${LEVEL_COLUMNS} FROM pass_levels l WHERE l.id = ?1`).bind(id).first<PassLevel>();
}

// Editing a level changes what it says and where it sits; whoever has
// reached it keeps it, even if the line moves above their XP.
export async function savePassLevel(db: D1Database, id: number, input: PassLevelInput, now: number): Promise<PassLevel> {
  const before = await getPassLevel(db, id);
  if (!before) throw new RuleError('missing', 'That level is no longer on the list.');
  const level = validLevel(input);
  const same = await db.prepare('SELECT id FROM pass_levels WHERE season_year = ?1 AND xp = ?2 AND id <> ?3').bind(before.season_year, level.xp, id).first();
  if (same) throw new RuleError('duplicate', 'A level at that XP is already there.');
  await db
    .prepare('UPDATE pass_levels SET xp = ?2, name = ?3, reward = ?4, sponsor = ?5, role_id = ?6, updated_at = ?7 WHERE id = ?1')
    .bind(id, level.xp, level.name, level.reward, level.sponsor, level.role_id, now)
    .run();
  await renumber(db, before.season_year);
  return (await getPassLevel(db, id))!;
}

// A level nobody has reached can go. One that someone has reached has
// been announced and its reward given, so it stays; edit it instead.
export async function removePassLevel(db: D1Database, id: number): Promise<boolean> {
  const before = await getPassLevel(db, id);
  if (!before) return false;
  if (before.reached > 0) throw new RuleError('reached', 'Someone has reached that level; edit it rather than remove it.');
  await db.prepare('DELETE FROM pass_levels WHERE id = ?1').bind(id).run();
  await renumber(db, before.season_year);
  return true;
}

// --- where a member stands ---------------------------------------------------

export interface PassProgress {
  xp: number;
  levels: PassLevel[]; // the season's, lowest first
  current: PassLevel | null; // the highest level their XP reaches
  next: PassLevel | null; // the first one it does not
  to_next: number; // XP still needed for `next`, 0 when there is none
  fraction: number; // 0..1 of the way from the last line crossed to the next
}

// Pure: the track read against an XP total. The pass is judged by XP
// alone here; the ledger (below) is what remembers a level once crossed.
export function passProgress(xp: number, levels: PassLevel[]): PassProgress {
  const sorted = [...levels].sort((a, b) => a.xp - b.xp);
  const reached = sorted.filter((l) => l.xp <= xp);
  const current = reached.at(-1) ?? null;
  const next = sorted.find((l) => l.xp > xp) ?? null;
  const floor = current?.xp ?? 0;
  const fraction = next ? Math.min(1, Math.max(0, (xp - floor) / (next.xp - floor))) : 1;
  return { xp, levels: sorted, current, next, to_next: next ? next.xp - xp : 0, fraction };
}

export function levelTitle(level: Pick<PassLevel, 'level' | 'name'>): string {
  return `Level ${level.level} · ${level.name}`;
}

export function rewardText(level: Pick<PassLevel, 'reward' | 'sponsor'>): string {
  return level.sponsor ? `${level.reward} (from ${level.sponsor})` : level.reward;
}

// The pass block of the /season answer.
export function passLines(progress: PassProgress, origin: string): string[] {
  if (progress.levels.length === 0) {
    return [`🎫 Season pass: **${progress.xp} XP**. The board has not set this season's levels yet; the XP counts already.`];
  }
  const lines = [`🎫 Season pass: **${progress.xp} XP**${progress.current ? ` · **${levelTitle(progress.current)}**` : ' · no level yet'}`];
  if (progress.next) {
    lines.push(`${bar(progress.fraction)} **${progress.to_next} XP** to ${levelTitle(progress.next)}: ${rewardText(progress.next)}`);
  } else {
    lines.push(`${bar(1)} Every level of the season reached.`);
  }
  lines.push(`All the levels and rewards: ${origin}/membership#pass`);
  return lines;
}

// Ten blocks, the reached ones filled.
export function bar(fraction: number, width = 10): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

// --- the ledger, and telling people --------------------------------------------

export interface Reached {
  discord_id: string;
  username: string | null;
  handle: string | null;
  hidden: boolean;
  level: PassLevel;
  xp: number;
}

// Writes every level crossing the ledger does not have yet, for the
// current season, and returns the new ones. Idempotent: a second run in
// the same minute returns nothing. Members whose XP dropped back under a
// line they crossed earlier keep the row.
export async function recordReached(db: D1Database, now: number): Promise<Reached[]> {
  const year = seasonStartYear(now);
  const levels = await listPassLevels(db, year);
  if (levels.length === 0) return [];
  const standings = await xpStandings(db, now);
  const out: Reached[] = [];
  for (const s of standings) {
    for (const level of levels) {
      if (level.xp > s.xp) continue;
      const result = await db
        .prepare('INSERT OR IGNORE INTO pass_reached (discord_id, level_id, xp, reached_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(s.discord_id, level.id, s.xp, now)
        .run();
      if ((result.meta.changes ?? 0) > 0) out.push({ discord_id: s.discord_id, username: s.username, handle: s.handle, hidden: s.hidden, level, xp: s.xp });
    }
  }
  return out;
}

// The levels a member holds this season, from the ledger.
export async function memberReached(db: D1Database, discordId: string, seasonYear: number): Promise<number[]> {
  const { results } = await db
    .prepare('SELECT l.id FROM pass_reached r JOIN pass_levels l ON l.id = r.level_id WHERE r.discord_id = ?1 AND l.season_year = ?2')
    .bind(discordId, seasonYear)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

function safe(text: string): string {
  return text.replace(/[`*_~|>\[\]()@#]/g, '').trim();
}

// The public line, to the general channel: who, which level, what it
// pays. When several levels are crossed at once (a big tick), the
// highest is the news and the rest are in the same line.
export function reachedLine(name: string, levels: PassLevel[], seasonYear: number): string {
  const top = [...levels].sort((a, b) => b.level - a.level)[0];
  const rewards = [...levels].sort((a, b) => a.level - b.level).map((l) => `${levelTitle(l)}: ${safe(rewardText(l))}`);
  const head = `🎫 **${safe(name)}** reached **${levelTitle(top)}** on the ${seasonName(seasonYear)} season pass!`;
  return levels.length === 1 ? `${head} Reward: ${safe(rewardText(top))}.` : `${head}\n${rewards.map((r) => `• ${r}`).join('\n')}`;
}

// The private version, for a member who is hidden from leaderboards.
export function reachedDm(levels: PassLevel[], seasonYear: number, origin: string): string {
  const rewards = [...levels].sort((a, b) => a.level - b.level).map((l) => `• ${levelTitle(l)}: ${rewardText(l)}`);
  return `🎫 You reached ${levels.length === 1 ? 'a new level' : `${levels.length} new levels`} on the ${seasonName(seasonYear)} season pass.\n${rewards.join('\n')}\nYou are hidden from the leaderboard, so the server was not told. ${origin}/membership#pass`;
}

export interface PassEnv {
  DISCORD_BOT_TOKEN?: string;
  WELCOME_WEBHOOK_URL?: string;
}

// The hourly step: record what is newly reached, then tell people and
// give the roles, one message per member however many levels they
// crossed. Each row is marked announced before its message goes, so a
// Discord hiccup costs one announcement, never a repeat. Returns how many
// members were told.
export async function announceReached(db: D1Database, env: PassEnv, origin: string, now: number): Promise<number> {
  const fresh = await recordReached(db, now);
  const year = seasonStartYear(now);
  const byMember = new Map<string, Reached[]>();
  for (const r of fresh) byMember.set(r.discord_id, [...(byMember.get(r.discord_id) ?? []), r]);
  let told = 0;
  for (const [discordId, rows] of byMember) {
    await db.batch(rows.map((r) => db.prepare('UPDATE pass_reached SET announced_at = ?3 WHERE discord_id = ?1 AND level_id = ?2').bind(discordId, r.level.id, now)));
    const levels = rows.map((r) => r.level);
    const first = rows[0];
    if (env.DISCORD_BOT_TOKEN) {
      for (const level of levels) {
        if (level.role_id) await setGuildMemberRole(env.DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, discordId, level.role_id, true);
      }
    }
    if (first.hidden) {
      if (env.DISCORD_BOT_TOKEN && (await dmUser(env.DISCORD_BOT_TOKEN, discordId, reachedDm(levels, year, origin)))) told++;
      continue;
    }
    if (env.WELCOME_WEBHOOK_URL) {
      const name = shownName({ discord_id: discordId, username: first.username, handle: first.handle } as Standing);
      if ((await postWebhook(env.WELCOME_WEBHOOK_URL, reachedLine(name, levels, year), NO_MENTIONS, SUPPRESS_EMBEDS)) !== null) told++;
    }
  }
  return told;
}
