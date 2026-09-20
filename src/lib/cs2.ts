// Handing a bracket match to a Counter-Strike server, and taking the result
// back.
//
// The site is the controller. MatchZy-Enhanced pulls its match config from
// /api/cs2/match/<id>.json and posts its events to /api/cs2/events, and both
// of those connections are made BY THE GAME SERVER. Nothing here ever dials
// the servers, which is the only reason a Cloudflare Worker can run this at
// all: the servers sit behind a home connection with no inbound path to
// them, and RCON is not exposed to the internet and should not be.
//
// The bracket stays the record of what happened. These rows are the live
// picture of one attempt at one bracket match, and everything that decides
// a result goes through setBracketGames/setBracketWinner in db.ts, exactly
// as the board's own buttons do.

import type { D1Database } from '@cloudflare/workers-types';
import {
  RuleError,
  getBracketMatch,
  getBracketRow,
  setBracketGames,
  setBracketWinner,
  type BracketMatch,
  type BracketRow,
} from './db';
import { bestOfFor, winsNeeded } from './scores';

// The 2026 Active Duty pool. A veto that offers a map the server does not
// have strands the match at the map change, so this list and the maps
// installed on the servers have to agree (scripts/cs2/preflight.sh checks).
export const CS2_MAPPOOL = [
  'de_ancient',
  'de_anubis',
  'de_dust2',
  'de_inferno',
  'de_mirage',
  'de_nuke',
  'de_overpass',
] as const;

export const CS2_SERVER_IDS = ['1', '2'] as const;
export type CS2ServerId = (typeof CS2_SERVER_IDS)[number];

export function isServerId(value: unknown): value is CS2ServerId {
  return value === '1' || value === '2';
}

export type CS2Status = 'pending' | 'live' | 'done' | 'cancelled';

export interface CS2MatchRow {
  id: number;
  bracket_id: number;
  event_id: number;
  round: number;
  slot: number;
  server: string;
  best_of: number;
  side_a: string;
  side_b: string;
  name_a: string;
  name_b: string;
  status: CS2Status;
  sent_at: number | null;
  maps_a: number;
  maps_b: number;
  last_map_number: number | null;
  current_map: string | null;
  rounds_a: number | null;
  rounds_b: number | null;
  wrote_winner: string | null;
  created_at: number;
  updated_at: number;
}

// --- the match config the server pulls -------------------------------------

export interface MatchConfig {
  matchid: string;
  num_maps: number;
  players_per_team: number;
  min_players_to_ready: number;
  skip_veto: boolean;
  maplist: string[];
  clinch_series: boolean;
  team1: { name: string; players: Record<string, string> };
  team2: { name: string; players: Record<string, string> };
  cvars: Record<string, string>;
}

// MatchZy parses matchid as a 32-bit SIGNED int. Anything larger is refused
// with "matchid should be an integer!" — which is why the row id is the
// matchid: a counter starting at 1 cannot reach the limit in this lifetime.
export const MATCHID_MAX = 2 ** 31 - 1;

export function isUsableMatchId(id: number): boolean {
  return Number.isInteger(id) && id > 0 && id <= MATCHID_MAX;
}

/**
 * The config for one attempt.
 *
 * Both rosters are EMPTY, and that is the whole point. A MatchZy roster
 * kicks every connected player who is not on it, so a partial roster kicks
 * the players it forgot and one empty roster beside a full one kicks that
 * whole team — it emptied a live server once. Two empty rosters kick
 * nobody, need nobody's SteamID collected beforehand, and let the
 * LahtiAGTeams plugin work the teams out from the sides at match start.
 *
 * team1 starts CT. The bracket's side_a is team1, so a result reported
 * against team1 belongs to side_a without any further mapping.
 */
export function buildMatchConfig(row: {
  id: number;
  best_of: number;
  name_a: string;
  name_b: string;
}): MatchConfig {
  if (!isUsableMatchId(row.id)) throw new RuleError('bad_input', 'Unusable match id.');
  const bo = row.best_of;
  if (![1, 3, 5].includes(bo)) throw new RuleError('bad_input', 'A server match is best-of 1, 3 or 5.');
  return {
    matchid: String(row.id),
    num_maps: bo,
    players_per_team: 5,
    // Anyone on the server can ready the match up: there is no roster to
    // count against, so a threshold above 1 would simply never be met.
    min_players_to_ready: 1,
    // The captains ban in game with .ban. Running the veto on the server
    // keeps the whole thing working when the site is unreachable, which is
    // the one moment a tournament cannot wait.
    skip_veto: false,
    maplist: [...CS2_MAPPOOL],
    clinch_series: true,
    team1: { name: row.name_a, players: {} },
    team2: { name: row.name_b, players: {} },
    cvars: {
      // With no config loaded MatchZy re-execs warmup.cfg, which resets
      // these two; pinning them in the config is what makes them stick.
      mp_startmoney: '800',
      mp_starting_losses: '0',
    },
  };
}

// --- events the server posts back ------------------------------------------

export interface MapResult {
  kind: 'map_result';
  matchid: number;
  mapNumber: number;
  seriesA: number;
  seriesB: number;
  roundsA: number;
  roundsB: number;
}

export interface SeriesEnd {
  kind: 'series_end';
  matchid: number;
  winner: 'a' | 'b' | null;
  seriesA: number;
  seriesB: number;
}

export interface GoingLive {
  kind: 'going_live';
  matchid: number;
  mapNumber: number;
}

export interface RoundEnd {
  kind: 'round_end';
  matchid: number;
  mapNumber: number;
  roundsA: number;
  roundsB: number;
}

export type CS2Event = MapResult | SeriesEnd | GoingLive | RoundEnd;

const asInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;

/**
 * Read one MatchZy event.
 *
 * Returns null for every event we do not act on, which is most of them —
 * the plugin sends player deaths, grenades, demo progress and more. An
 * unknown event is not an error: the server is chatty by design and its
 * retry queue will keep resending anything we answer badly.
 *
 * `winner.team` is the string "team1"/"team2"; team1 is always side A.
 */
export function parseEvent(body: unknown): CS2Event | null {
  if (typeof body !== 'object' || body === null) return null;
  const e = body as Record<string, unknown>;
  const matchid = asInt(e.matchid);
  if (matchid === null || matchid <= 0) return null;

  switch (e.event) {
    case 'going_live': {
      const mapNumber = asInt(e.map_number);
      return mapNumber === null ? null : { kind: 'going_live', matchid, mapNumber };
    }
    case 'round_end': {
      const mapNumber = asInt(e.map_number);
      const t1 = e.team1 as Record<string, unknown> | undefined;
      const t2 = e.team2 as Record<string, unknown> | undefined;
      const roundsA = asInt(t1?.score);
      const roundsB = asInt(t2?.score);
      if (mapNumber === null || roundsA === null || roundsB === null) return null;
      return { kind: 'round_end', matchid, mapNumber, roundsA, roundsB };
    }
    case 'map_result': {
      const mapNumber = asInt(e.map_number);
      const t1 = e.team1 as Record<string, unknown> | undefined;
      const t2 = e.team2 as Record<string, unknown> | undefined;
      const seriesA = asInt(t1?.series_score);
      const seriesB = asInt(t2?.series_score);
      if (mapNumber === null || seriesA === null || seriesB === null) return null;
      return {
        kind: 'map_result',
        matchid,
        mapNumber,
        seriesA,
        seriesB,
        roundsA: asInt(t1?.score) ?? 0,
        roundsB: asInt(t2?.score) ?? 0,
      };
    }
    case 'series_end': {
      const seriesA = asInt(e.team1_series_score);
      const seriesB = asInt(e.team2_series_score);
      if (seriesA === null || seriesB === null) return null;
      const team = (e.winner as Record<string, unknown> | undefined)?.team;
      const winner = team === 'team1' ? 'a' : team === 'team2' ? 'b' : null;
      return { kind: 'series_end', matchid, winner, seriesA, seriesB };
    }
    default:
      return null;
  }
}

/**
 * Whether a map_result tells us anything new.
 *
 * MatchZy has a retry queue: a delivery we answer with anything but 2xx
 * comes back, and so can one we answered fine if the reply was lost. Map 1's
 * result arriving again after map 2 has been played would walk the bracket
 * backwards, so a map number we have already recorded is ignored.
 */
export function isFreshMap(row: { last_map_number: number | null }, mapNumber: number): boolean {
  return row.last_map_number === null || mapNumber > row.last_map_number;
}

/**
 * What a series score means for the bracket, given the format.
 *
 * A best-of-one has no games to count — setBracketGames refuses one, by
 * design, because 1–0 of a best-of-one is just "decided" — so it is
 * recorded as a plain win instead.
 */
export function bracketUpdateFor(
  bestOf: number,
  seriesA: number,
  seriesB: number,
): { kind: 'games'; a: number; b: number } | { kind: 'win'; side: 'a' | 'b' } | null {
  if (bestOf > 1) return { kind: 'games', a: seriesA, b: seriesB };
  const need = winsNeeded(bestOf); // 1
  if (seriesA >= need && seriesA > seriesB) return { kind: 'win', side: 'a' };
  if (seriesB >= need && seriesB > seriesA) return { kind: 'win', side: 'b' };
  return null;
}

// --- storage ---------------------------------------------------------------

export async function getCS2Match(db: D1Database, id: number): Promise<CS2MatchRow | null> {
  if (!isUsableMatchId(id)) return null;
  return db.prepare('SELECT * FROM cs2_matches WHERE id = ?1').bind(id).first<CS2MatchRow>();
}

export async function listCS2Matches(db: D1Database, bracketId: number): Promise<CS2MatchRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM cs2_matches WHERE bracket_id = ?1 ORDER BY id DESC')
    .bind(bracketId)
    .all<CS2MatchRow>();
  return results;
}

// The attempt currently on each server, for the board's "what is running"
// line. At most one per server: the partial unique index enforces it.
export async function activeCS2Matches(db: D1Database): Promise<CS2MatchRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM cs2_matches WHERE status IN ('pending', 'live') ORDER BY server")
    .all<CS2MatchRow>();
  return results;
}

/**
 * Hand a bracket match to a server.
 *
 * Refuses rather than guesses: both sides have to be known, the match must
 * not already be decided, and neither the slot nor the server may be busy.
 * The last two are also unique indexes, so a double-submitted form cannot
 * get past them even if two requests read the table at the same moment.
 */
export async function sendMatchToServer(
  db: D1Database,
  bracket: BracketRow,
  match: BracketMatch,
  totalRounds: number,
  server: string,
  names: { a: string; b: string },
  now: number,
): Promise<CS2MatchRow> {
  if (!isServerId(server)) throw new RuleError('bad_input', 'That is not one of the servers.');
  if (match.side_a === null || match.side_b === null) {
    throw new RuleError('bad_input', 'Both sides of the match must be known first.');
  }
  if (match.winner !== null) throw new RuleError('bad_input', 'That match is already decided.');

  const bestOf = bestOfFor(bracket, match.round, totalRounds);
  if (![1, 3, 5].includes(bestOf)) {
    throw new RuleError('bad_input', `A best-of-${bestOf} cannot be run on the servers.`);
  }

  // Checked before inserting so the board gets a message naming the thing
  // that is in the way. The two partial unique indexes behind this are the
  // backstop for the race a double-submitted form can still win.
  const busy = await db
    .prepare(
      `SELECT server, bracket_id, round, slot FROM cs2_matches
        WHERE status IN ('pending', 'live')
          AND (server = ?1 OR (bracket_id = ?2 AND round = ?3 AND slot = ?4))`,
    )
    .bind(server, bracket.id, match.round, match.slot)
    .first<{ server: string }>();
  if (busy) {
    throw new RuleError(
      'bad_input',
      busy.server === server
        ? `Server ${server} already has a match on it.`
        : 'That match is already on a server.',
    );
  }

  try {
    const row = await db
      .prepare(
        `INSERT INTO cs2_matches
           (bracket_id, event_id, round, slot, server, best_of,
            side_a, side_b, name_a, name_b, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?11)
         RETURNING *`,
      )
      .bind(
        bracket.id,
        match.event_id,
        match.round,
        match.slot,
        server,
        bestOf,
        match.side_a,
        match.side_b,
        names.a,
        names.b,
        now,
      )
      .first<CS2MatchRow>();
    return row!;
  } catch (error) {
    // Two requests got past the check above at the same moment; the index
    // caught the loser. D1's message names the columns rather than the
    // index, so this does not try to tell the two cases apart.
    if (String((error as Error)?.message ?? '').includes('UNIQUE constraint failed: cs2_matches')) {
      throw new RuleError('bad_input', 'That match, or that server, is already busy.');
    }
    throw error;
  }
}

// Withdraw an attempt. The server is NOT told: stopping a match that people
// are playing is a decision for whoever is standing next to them, and the
// one thing this integration must never do is reach into a live game on a
// timer. This only stops the site listening for it.
export async function cancelCS2Match(db: D1Database, id: number, now: number): Promise<void> {
  await db
    .prepare("UPDATE cs2_matches SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status IN ('pending', 'live')")
    .bind(id, now)
    .run();
}

/**
 * Apply one event.
 *
 * Returns what it did, for the endpoint's reply and the tests. A cancelled
 * or finished attempt swallows everything: the board withdrew it, and a
 * server that keeps reporting must not write to the bracket any more.
 */
export async function applyCS2Event(
  db: D1Database,
  event: CS2Event,
  now: number,
): Promise<{ applied: string; detail?: string }> {
  const row = await getCS2Match(db, event.matchid);
  if (!row) return { applied: 'unknown_match' };
  if (row.status === 'cancelled' || row.status === 'done') return { applied: 'ignored', detail: row.status };

  const touch = (sql: string, binds: unknown[]) =>
    db.prepare(sql).bind(...binds, now, row.id).run();

  if (event.kind === 'going_live') {
    await touch("UPDATE cs2_matches SET status = 'live', updated_at = ?1 WHERE id = ?2", []);
    return { applied: 'live' };
  }

  if (event.kind === 'round_end') {
    await touch(
      'UPDATE cs2_matches SET rounds_a = ?1, rounds_b = ?2, updated_at = ?3 WHERE id = ?4',
      [event.roundsA, event.roundsB],
    );
    return { applied: 'rounds' };
  }

  if (event.kind === 'map_result') {
    if (!isFreshMap(row, event.mapNumber)) return { applied: 'stale_map' };
    await touch(
      `UPDATE cs2_matches
          SET maps_a = ?1, maps_b = ?2, last_map_number = ?3, rounds_a = ?4, rounds_b = ?5,
              updated_at = ?6
        WHERE id = ?7`,
      [event.seriesA, event.seriesB, event.mapNumber, event.roundsA, event.roundsB],
    );
    return { applied: 'map', detail: await writeToBracket(db, row, event.seriesA, event.seriesB) };
  }

  // series_end: the safety net. The map results should already have decided
  // the bracket match; this catches a lost map_result and settles it.
  await touch(
    "UPDATE cs2_matches SET status = 'done', maps_a = ?1, maps_b = ?2, updated_at = ?3 WHERE id = ?4",
    [event.seriesA, event.seriesB],
  );
  return { applied: 'series_end', detail: await writeToBracket(db, row, event.seriesA, event.seriesB) };
}

/**
 * Put a series score into the bracket, through the same functions the
 * board's own buttons use — so a result reported by a server advances the
 * draw, seats the bronze match and is corrected later in exactly the way a
 * hand-entered one is. Nothing here writes bracket_matches directly.
 */
async function writeToBracket(
  db: D1Database,
  row: CS2MatchRow,
  seriesA: number,
  seriesB: number,
): Promise<string> {
  const update = bracketUpdateFor(row.best_of, seriesA, seriesB);
  if (!update) return 'nothing_to_record';

  // THE BOARD'S WORD IS FINAL. A bracket match already decided by anything
  // other than this attempt is left exactly as it is. Without this, a late
  // redelivery of map 1 walks a hand-settled result backwards: the board
  // records 2-0 to settle a dispute, a queued map_result turns up saying
  // 1-0, setBracketGames reads that as "still being played" and takes the
  // winner back out of every round it had advanced to.
  const current = await getBracketMatch(db, row.bracket_id, row.round, row.slot);
  if (current?.winner != null && current.winner !== row.wrote_winner) {
    return 'board_decided';
  }

  try {
    if (update.kind === 'games') {
      await setBracketGames(db, row.bracket_id, row.round, row.slot, update.a, update.b);
      await rememberWinner(db, row.id, (await getBracketMatch(db, row.bracket_id, row.round, row.slot))?.winner ?? null);
      return `games ${update.a}-${update.b}`;
    }
    const winner = update.side === 'a' ? row.side_a : row.side_b;
    await setBracketWinner(db, row.bracket_id, row.round, row.slot, winner);
    await rememberWinner(db, row.id, winner);
    return `winner ${winner}`;
  } catch (error) {
    // A bracket that has moved on under us (the board recorded the result
    // by hand, someone redrew the round) must not make the server retry
    // forever. Record why and accept the delivery.
    if (error instanceof RuleError) return `refused:${error.code}`;
    throw error;
  }
}

async function rememberWinner(db: D1Database, id: number, winner: string | null): Promise<void> {
  await db.prepare('UPDATE cs2_matches SET wrote_winner = ?2 WHERE id = ?1').bind(id, winner).run();
}

// --- the queue the AMP-host bridge drains -----------------------------------

/**
 * Matches waiting to be loaded onto a server.
 *
 * Only ever `pending` attempts nobody has told a server about yet. The
 * bridge claims one with markMatchSent BEFORE touching the server, because
 * matchzy_loadmatch over an autostarted live match destroys it silently:
 * a queue that kept re-offering the same match would wreck a game a minute.
 */
export async function queuedMatches(db: D1Database): Promise<CS2MatchRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM cs2_matches WHERE status = 'pending' AND sent_at IS NULL ORDER BY id")
    .all<CS2MatchRow>();
  return results;
}

/**
 * Claim a queued match. Returns false when somebody already claimed it,
 * which is the bridge's signal to leave the server alone.
 */
export async function markMatchSent(db: D1Database, id: number, now: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE cs2_matches SET sent_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'pending' AND sent_at IS NULL")
    .bind(id, now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** The bracket's own view of an attempt, for the page. */
export async function cs2BestOf(
  db: D1Database,
  bracketId: number,
  round: number,
  totalRounds: number,
): Promise<number> {
  const bracket = await getBracketRow(db, bracketId);
  if (!bracket) throw new RuleError('missing', 'No such bracket.');
  return bestOfFor(bracket, round, totalRounds);
}
