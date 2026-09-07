// Ticks: what the board notes by hand for the season pass, because nothing
// can count it on its own. Helping at an event is the first kind; the
// board keeps the list itself on the season page, so a new kind needs no
// code. A tick is one kind given to one register entry by a board member,
// optionally for one event, and a member sees their own under /season and
// on the membership page. A kind says what a tick is worth (XP) and how
// many times a season it counts; a tick keeps the XP it was given with,
// so last season's totals never move when the board changes a kind.
import type { D1Database } from '@cloudflare/workers-types';
import { RuleError } from './db';
import { seasonStartYear } from './activity';
import { helsinkiToUnix } from './time';

export interface TickKind {
  id: number;
  name: string;
  description: string | null;
  sort: number;
  xp: number; // what one tick is worth
  season_cap: number; // how many count per member and season; 0 = every one
  retired_at: number | null;
  given: number; // ticks ever given under it
}

export interface TickRow {
  id: number;
  kind_id: number;
  kind: string;
  register_id: number;
  member: string; // the register entry's full name
  discord_id: string | null;
  event_id: number | null;
  event: string | null; // the event's title, if it still exists
  note: string | null;
  xp: number;
  given_by: string;
  given_at: number;
}

// What a member sees of their own ticks: no names of who gave them.
export interface SeasonTick {
  kind_id: number;
  kind: string;
  event: string | null;
  given_at: number;
  xp: number;
  season_cap: number;
}

export interface TickKindInput {
  name: unknown;
  description: unknown;
  xp: unknown;
  season_cap: unknown;
}

export interface TickableMember {
  register_id: number;
  full_name: string;
  discord_name: string | null;
  discord_id: string | null;
}

export const TICK_LIMITS = { name: 60, description: 160, note: 200, xp: 10_000, season_cap: 100 } as const;

function clean(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
}

// --- the kinds ---------------------------------------------------------------

const KIND_COLUMNS = `k.id, k.name, k.description, k.sort, k.xp, k.season_cap, k.retired_at,
  (SELECT COUNT(*) FROM ticks t WHERE t.kind_id = k.id) AS given`;

export async function listTickKinds(db: D1Database, includeRetired = false): Promise<TickKind[]> {
  const { results } = await db
    .prepare(`SELECT ${KIND_COLUMNS} FROM tick_kinds k ${includeRetired ? '' : 'WHERE k.retired_at IS NULL'} ORDER BY k.sort, k.id`)
    .all<TickKind>();
  return results;
}

export async function getTickKind(db: D1Database, id: number): Promise<TickKind | null> {
  return db.prepare(`SELECT ${KIND_COLUMNS} FROM tick_kinds k WHERE k.id = ?1`).bind(id).first<TickKind>();
}

// A whole number from a form field; blank counts as zero.
function whole(raw: unknown, max: number): number {
  const text = String(raw ?? '').trim();
  if (text === '') return 0;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new RuleError('bad_input', `A whole number from 0 to ${max}.`);
  return n;
}

function validKind(input: TickKindInput): { name: string; description: string | null; xp: number; season_cap: number } {
  const name = clean(input.name, TICK_LIMITS.name);
  const description = clean(input.description, TICK_LIMITS.description);
  if (name.length < 2 || name.length > TICK_LIMITS.name) throw new RuleError('bad_input', 'A tick needs a name of 2 to 60 characters.');
  if (description.length > TICK_LIMITS.description) throw new RuleError('bad_input', 'The description is too long.');
  return {
    name,
    description: description === '' ? null : description,
    xp: whole(input.xp, TICK_LIMITS.xp),
    season_cap: whole(input.season_cap, TICK_LIMITS.season_cap),
  };
}

// Two kinds with the same name would be two lists of the same thing.
async function nameTaken(db: D1Database, name: string, exceptId: number | null): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM tick_kinds WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2')
    .bind(name, exceptId)
    .first<{ id: number }>();
  return row !== null;
}

export async function addTickKind(db: D1Database, input: TickKindInput, by: string, now: number): Promise<TickKind> {
  const { name, description, xp, season_cap } = validKind(input);
  if (await nameTaken(db, name, null)) throw new RuleError('duplicate', `There is already a tick called ${name}.`);
  const last = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS sort FROM tick_kinds').first<{ sort: number }>();
  const result = await db
    .prepare('INSERT INTO tick_kinds (name, description, sort, xp, season_cap, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(name, description, (last?.sort ?? 0) + 1, xp, season_cap, by, now)
    .run();
  const id = Number(result.meta.last_row_id);
  return (await getTickKind(db, id))!;
}

// Saving a kind changes what ticks given from now on are worth; with
// `applySeason` the ticks of that season already given under it follow,
// for when the numbers are settled after the ticking began.
export async function saveTickKind(db: D1Database, id: number, input: TickKindInput, applySeason: number | null = null): Promise<TickKind> {
  const { name, description, xp, season_cap } = validKind(input);
  if (!(await getTickKind(db, id))) throw new RuleError('missing', 'No such tick.');
  if (await nameTaken(db, name, id)) throw new RuleError('duplicate', `There is already a tick called ${name}.`);
  await db
    .prepare('UPDATE tick_kinds SET name = ?2, description = ?3, xp = ?4, season_cap = ?5 WHERE id = ?1')
    .bind(id, name, description, xp, season_cap)
    .run();
  if (applySeason !== null) {
    const { from, to } = seasonRange(applySeason);
    await db.prepare('UPDATE ticks SET xp = ?2 WHERE kind_id = ?1 AND given_at >= ?3 AND given_at < ?4').bind(id, xp, from, to).run();
  }
  return (await getTickKind(db, id))!;
}

// A retired kind leaves the give list; the ticks under it stay and count.
export async function setTickKindRetired(db: D1Database, id: number, retired: boolean, now: number): Promise<boolean> {
  const result = await db.prepare('UPDATE tick_kinds SET retired_at = ?2 WHERE id = ?1').bind(id, retired ? now : null).run();
  return (result.meta.changes ?? 0) > 0;
}

// --- giving ------------------------------------------------------------------

const TICK_COLUMNS = `t.id, t.kind_id, k.name AS kind, t.register_id, r.full_name AS member, r.discord_id,
  t.event_id, e.title AS event, t.note, t.xp, t.given_by, t.given_at
  FROM ticks t
  JOIN tick_kinds k ON k.id = t.kind_id
  JOIN register r ON r.id = t.register_id
  LEFT JOIN events e ON e.id = t.event_id`;

// Current members, the ones a tick can go to, by name.
export async function listTickableMembers(db: D1Database): Promise<TickableMember[]> {
  const { results } = await db
    .prepare("SELECT id AS register_id, full_name, discord_name, discord_id FROM register WHERE status = 'member' ORDER BY full_name COLLATE NOCASE")
    .all<TickableMember>();
  return results;
}

export async function giveTick(
  db: D1Database,
  input: { kindId: number; registerId: number; eventId: number | null; note?: unknown },
  by: string,
  now: number,
): Promise<TickRow> {
  const kind = await getTickKind(db, input.kindId);
  if (!kind || kind.retired_at !== null) throw new RuleError('missing', 'That tick is not on the list.');
  const member = await db.prepare('SELECT status FROM register WHERE id = ?1').bind(input.registerId).first<{ status: string }>();
  if (!member) throw new RuleError('missing', 'No such register entry.');
  if (member.status !== 'member') throw new RuleError('not_member', 'Ticks go to current members.');
  if (input.eventId !== null) {
    const event = await db.prepare('SELECT id FROM events WHERE id = ?1').bind(input.eventId).first<{ id: number }>();
    if (!event) throw new RuleError('missing', 'No such event.');
    const dup = await db
      .prepare('SELECT id FROM ticks WHERE kind_id = ?1 AND register_id = ?2 AND event_id = ?3')
      .bind(input.kindId, input.registerId, input.eventId)
      .first<{ id: number }>();
    if (dup) throw new RuleError('duplicate', 'They already have that tick for this event.');
  }
  const note = clean(input.note, TICK_LIMITS.note);
  if (note.length > TICK_LIMITS.note) throw new RuleError('bad_input', 'The note is too long.');
  const result = await db
    .prepare('INSERT INTO ticks (kind_id, register_id, event_id, note, xp, given_by, given_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(input.kindId, input.registerId, input.eventId, note === '' ? null : note, kind.xp, by, now)
    .run();
  return (await getTick(db, Number(result.meta.last_row_id)))!;
}

export async function getTick(db: D1Database, id: number): Promise<TickRow | null> {
  return db.prepare(`SELECT ${TICK_COLUMNS} WHERE t.id = ?1`).bind(id).first<TickRow>();
}

export async function removeTick(db: D1Database, id: number): Promise<TickRow | null> {
  const row = await getTick(db, id);
  if (!row) return null;
  await db.prepare('DELETE FROM ticks WHERE id = ?1').bind(id).run();
  return row;
}

// A season as a half-open range of seconds: 1 September to the next one.
// Every list here is cut by the moment a tick was given, so last season's
// ticks never count in this one.
export function seasonRange(startYear: number): { from: number; to: number } {
  return {
    from: helsinkiToUnix(`${startYear}-09-01`, '00:00') ?? 0,
    to: helsinkiToUnix(`${startYear + 1}-09-01`, '00:00') ?? Number.MAX_SAFE_INTEGER,
  };
}

// The ticks given in a season, newest first; for one event when asked.
export async function listTicks(
  db: D1Database,
  startYear: number,
  options: { eventId?: number; limit?: number } = {},
): Promise<TickRow[]> {
  const limit = options.limit ?? 200;
  if (options.eventId !== undefined) {
    const { results } = await db
      .prepare(`SELECT ${TICK_COLUMNS} WHERE t.event_id = ?1 ORDER BY t.given_at DESC, t.id DESC LIMIT ?2`)
      .bind(options.eventId, limit)
      .all<TickRow>();
    return results;
  }
  const { from, to } = seasonRange(startYear);
  const { results } = await db
    .prepare(`SELECT ${TICK_COLUMNS} WHERE t.given_at >= ?1 AND t.given_at < ?2 ORDER BY t.given_at DESC, t.id DESC LIMIT ?3`)
    .bind(from, to, limit)
    .all<TickRow>();
  return results;
}

// The first tick ever given, for the season picker.
export async function firstTickAt(db: D1Database): Promise<number | null> {
  const row = await db.prepare('SELECT MIN(given_at) AS at FROM ticks').first<{ at: number | null }>();
  return row?.at ?? null;
}

// A member's own ticks in the current season, oldest first, found
// through the register entry linked to their Discord account.
export async function memberSeasonTicks(db: D1Database, discordId: string, now: number): Promise<SeasonTick[]> {
  const { from, to } = seasonRange(seasonStartYear(now));
  const { results } = await db
    .prepare(
      `SELECT t.kind_id, k.name AS kind, e.title AS event, t.given_at, t.xp, k.season_cap
       FROM ticks t
       JOIN tick_kinds k ON k.id = t.kind_id
       JOIN register r ON r.id = t.register_id
       LEFT JOIN events e ON e.id = t.event_id
       WHERE r.discord_id = ?1 AND t.given_at >= ?2 AND t.given_at < ?3
       ORDER BY t.given_at, t.id`,
    )
    .bind(discordId, from, to)
    .all<SeasonTick>();
  return results;
}

// "Helped at an event (Autumn LAN) · Helped at an event"
export function tickList(ticks: SeasonTick[]): string {
  return ticks.map((t) => (t.event ? `${t.kind} (${t.event})` : t.kind)).join(' · ');
}

// The XP a member's season ticks add up to: each tick is worth what it
// was given with, and a kind with a cap counts only its first ticks of
// the season (oldest first, the order memberSeasonTicks lists them in).
export function tickXp(ticks: SeasonTick[]): number {
  const seen = new Map<number, number>();
  let total = 0;
  for (const t of ticks) {
    const n = (seen.get(t.kind_id) ?? 0) + 1;
    seen.set(t.kind_id, n);
    if (t.season_cap === 0 || n <= t.season_cap) total += t.xp;
  }
  return total;
}

// "100 XP · once a season" for the pickers and the list.
export function kindWorth(kind: { xp: number; season_cap: number }): string {
  if (kind.xp === 0) return 'no XP yet';
  const cap = kind.season_cap === 0 ? '' : kind.season_cap === 1 ? ' · once a season' : ` · up to ${kind.season_cap} a season`;
  return `${kind.xp} XP${cap}`;
}
