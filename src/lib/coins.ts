// Coins: play money for members. Nothing buys them and they buy nothing
// outside the site; they are for betting on who wins an event's bracket,
// the way a sweepstake at a pub works. A member's balance is the sum of
// their ledger. Everyone starts with the same purse, gets a monthly
// allowance the first time they touch their wallet that month, and the
// board can hand coins out or take them back. Activity pays on the side:
// every XP of the battle pass is worth a few coins, paid by the cron as
// the XP comes in. A tournament's champions get a purse.
//
// Betting is pari-mutuel: every stake on an event goes into one pool, and
// when the final is decided the pool is shared among the members who
// picked the champion, in proportion to their stakes. No odds are set by
// anyone; the pool is the odds. If nobody picked the champion, every
// stake goes back. Betting opens when the event's bracket goes live,
// closes when the first result is recorded, and a reverted final undoes
// the payout. One bet per member per event; changing it while betting is
// open replaces it.
import type { D1Database } from '@cloudflare/workers-types';
import { RuleError, listSignups, getEvent, type BracketMatch, type EventRow } from './db';
import { helsinkiDay, seasonStartYear } from './activity';
import { xpStandings } from './xp';
import { isCurrentMember } from './minecraft';

export const COIN = '🪙';
export const START_COINS = 1000;
export const MONTHLY_ALLOWANCE = 500;
export const MIN_BET = 10;
export const MAX_BET = 100_000; // the wallet is the real limit
export const CHAMPION_PURSE = 250;
export const COINS_PER_XP = 2; // activity pays coins on the side: every XP of the season is worth this many

export type LedgerKind = 'start' | 'allowance' | 'activity' | 'bet' | 'refund' | 'payout' | 'unsettle' | 'purse' | 'grant';

export interface LedgerRow {
  id: number;
  amount: number;
  kind: LedgerKind;
  ref: string | null;
  note: string | null;
  created_at: number;
}

// What a bet is on: the bracket's champion, or one match.
export const WINNER = 'winner';
export const matchScope = (bracketId: number, round: number, slot: number): string => `m:${bracketId}:${round}:${slot}`;
export function parseMatchScope(scope: string): { bracketId: number; round: number; slot: number } | null {
  const m = /^m:(\d+):(\d+):(\d+)$/.exec(scope);
  return m ? { bracketId: Number(m[1]), round: Number(m[2]), slot: Number(m[3]) } : null;
}

export interface Market {
  event_id: number;
  scope: string;
  opened_at: number;
  closed_at: number | null;
  settled_at: number | null;
  winner: string | null;
}

export interface Bet {
  id: number;
  event_id: number;
  scope: string;
  discord_id: string;
  pick: string;
  amount: number;
  placed_at: number;
  result: 'won' | 'lost' | 'refunded' | null;
  payout: number;
}

export interface Odds {
  pool: number; // every stake together
  bets: number; // how many members are in
  picks: { pick: string; staked: number; backers: number; share: number; multiplier: number | null }[]; // by stake, biggest first
}

export function marketState(market: Market | null): 'none' | 'open' | 'closed' | 'settled' {
  if (!market) return 'none';
  if (market.settled_at !== null) return 'settled';
  if (market.closed_at !== null) return 'closed';
  return 'open';
}

// --- wallets --------------------------------------------------------------------------

async function add(db: D1Database, discordId: string, amount: number, kind: LedgerKind, ref: string | null, note: string | null, by: string | null, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO coin_ledger (discord_id, amount, kind, ref, note, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(discordId, amount, kind, ref, note, by, now)
    .run();
}

// The wallet a member has just opened: the starting purse the first time,
// and this week's allowance if it has not been paid yet. A member only;
// a wallet for someone outside the register would be coins from nowhere.
export async function ensureWallet(db: D1Database, discordId: string, now: number): Promise<{ started: boolean; allowance: boolean }> {
  if (!(await isCurrentMember(db, discordId))) throw new RuleError('not_member', 'Coins are for members.');
  const had = await db.prepare("SELECT 1 AS x FROM coin_ledger WHERE discord_id = ?1 AND kind = 'start'").bind(discordId).first();
  if (!had) await add(db, discordId, START_COINS, 'start', 'start', 'Welcome purse', null, now);
  const month = helsinkiDay(now).slice(0, 7);
  const paid = await db.prepare("SELECT 1 AS x FROM coin_ledger WHERE discord_id = ?1 AND kind = 'allowance' AND ref = ?2").bind(discordId, `month:${month}`).first();
  if (!paid) await add(db, discordId, MONTHLY_ALLOWANCE, 'allowance', `month:${month}`, `Allowance for ${month}`, null, now);
  return { started: !had, allowance: !paid };
}

export async function balance(db: D1Database, discordId: string): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM coin_ledger WHERE discord_id = ?1').bind(discordId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function ledger(db: D1Database, discordId: string, limit = 12): Promise<LedgerRow[]> {
  const { results } = await db
    .prepare('SELECT id, amount, kind, ref, note, created_at FROM coin_ledger WHERE discord_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2')
    .bind(discordId, limit)
    .all<LedgerRow>();
  return results;
}

// The board hands coins out (or takes them back with a negative amount).
export async function grantCoins(db: D1Database, discordId: string, amount: number, by: string, note: string, now: number): Promise<number> {
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000) throw new RuleError('bad_input', 'A whole number of coins, not zero.');
  await ensureWallet(db, discordId, now);
  await add(db, discordId, amount, 'grant', null, note.trim().slice(0, 120) || null, by, now);
  return balance(db, discordId);
}

// The champions' purse, once per member and event.
export async function payPurse(db: D1Database, eventId: number, discordIds: string[], now: number): Promise<string[]> {
  const paid: string[] = [];
  for (const id of discordIds) {
    if (!(await isCurrentMember(db, id))) continue;
    await ensureWallet(db, id, now);
    const before = await balance(db, id);
    await add(db, id, CHAMPION_PURSE, 'purse', `event:${eventId}`, 'Champion', null, now);
    if ((await balance(db, id)) !== before) paid.push(id);
  }
  return paid;
}

// Activity income: each member's season XP so far, times the rate, less
// what this season has paid already. Run by the cron; paying twice in a
// row changes nothing. Members hidden from leaderboards earn like anyone.
export async function payActivityCoins(db: D1Database, now: number): Promise<number> {
  const season = `xp:${seasonStartYear(now)}`;
  const standings = await xpStandings(db, now);
  const { results } = await db.prepare("SELECT discord_id, SUM(amount) AS paid FROM coin_ledger WHERE kind = 'activity' AND ref = ?1 GROUP BY discord_id").bind(season).all<{ discord_id: string; paid: number }>();
  const paid = new Map(results.map((r) => [r.discord_id, r.paid]));
  let members = 0;
  for (const s of standings) {
    const due = s.xp * COINS_PER_XP - (paid.get(s.discord_id) ?? 0);
    if (due <= 0) continue;
    if (!(await isCurrentMember(db, s.discord_id))) continue;
    await add(db, s.discord_id, due, 'activity', season, 'Battle pass XP', null, now);
    members++;
  }
  return members;
}

// The richest members, for a leaderboard. Hidden members stay out.
export async function richest(db: D1Database, limit = 10): Promise<{ discord_id: string; username: string; coins: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT l.discord_id, m.username, SUM(l.amount) AS coins
       FROM coin_ledger l JOIN members m ON m.discord_id = l.discord_id
       WHERE m.leaderboard_hidden = 0
       GROUP BY l.discord_id ORDER BY coins DESC, m.username LIMIT ?1`,
    )
    .bind(limit)
    .all<{ discord_id: string; username: string; coins: number }>();
  return results;
}

// --- markets -----------------------------------------------------------------------------

export async function getMarket(db: D1Database, eventId: number, scope = WINNER): Promise<Market | null> {
  return db.prepare('SELECT * FROM coin_markets WHERE event_id = ?1 AND scope = ?2').bind(eventId, scope).first<Market>();
}

export async function listMarkets(db: D1Database, eventId: number): Promise<Market[]> {
  const { results } = await db.prepare('SELECT * FROM coin_markets WHERE event_id = ?1 ORDER BY opened_at').bind(eventId).all<Market>();
  return results;
}

// Betting opens when the bracket goes live. Opening twice changes nothing.
export async function openMarket(db: D1Database, eventId: number, now: number, scope = WINNER): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO coin_markets (event_id, scope, opened_at) VALUES (?1, ?2, ?3)').bind(eventId, scope, now).run();
  return (result.meta.changes ?? 0) > 0;
}

// The first result closes it: from then on the stakes are locked.
export async function closeMarket(db: D1Database, eventId: number, now: number, scope = WINNER): Promise<boolean> {
  const result = await db.prepare('UPDATE coin_markets SET closed_at = ?2 WHERE event_id = ?1 AND scope = ?3 AND closed_at IS NULL').bind(eventId, now, scope).run();
  return (result.meta.changes ?? 0) > 0;
}

// Betting reopens when every result has been reverted; a settled pool
// must be unsettled first.
export async function reopenMarket(db: D1Database, eventId: number, scope = WINNER): Promise<boolean> {
  const result = await db.prepare('UPDATE coin_markets SET closed_at = NULL WHERE event_id = ?1 AND scope = ?2 AND settled_at IS NULL').bind(eventId, scope).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listBets(db: D1Database, eventId: number, scope = WINNER): Promise<Bet[]> {
  const { results } = await db.prepare('SELECT * FROM coin_bets WHERE event_id = ?1 AND scope = ?2 ORDER BY amount DESC, placed_at').bind(eventId, scope).all<Bet>();
  return results;
}

export async function myBets(db: D1Database, eventId: number, discordId: string): Promise<Bet[]> {
  const { results } = await db.prepare('SELECT * FROM coin_bets WHERE event_id = ?1 AND discord_id = ?2 ORDER BY placed_at').bind(eventId, discordId).all<Bet>();
  return results;
}

export async function myBet(db: D1Database, eventId: number, discordId: string, scope = WINNER): Promise<Bet | null> {
  return db.prepare('SELECT * FROM coin_bets WHERE event_id = ?1 AND scope = ?2 AND discord_id = ?3').bind(eventId, scope, discordId).first<Bet>();
}

// A stake on one participant: for the tournament, or for one match
// (`scope`), which needs both sides known and no result yet, and which
// opens its own little pool on the first stake while the bracket is
// live. Someone playing in the event may back their own side and nobody
// else's: a stake on an opponent is a reason to lose. Replacing an
// earlier bet gives that stake back first, so the balance check is
// against the whole wallet.
export async function placeBet(db: D1Database, eventId: number, discordId: string, pick: string, amount: number, pool: string[], own: string | null, now: number, scope = WINNER): Promise<Bet> {
  if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new RuleError('bad_input', `A stake is at least ${MIN_BET} coins.`);
  if (!pool.includes(pick)) throw new RuleError('missing', 'That team or player is not in the bracket.');
  if (own !== null && pick !== own) throw new RuleError('bad_input', 'Playing in this one? Then you can only back your own side.');
  const main = await getMarket(db, eventId, WINNER);
  if (!main) throw new RuleError('no_market', 'Betting has not opened for this event.');
  if (scope === WINNER) {
    if (marketState(main) !== 'open') throw new RuleError('closed', 'Betting on the winner is closed for this event.');
  } else {
    if (main.settled_at !== null) throw new RuleError('closed', 'The tournament is over.');
    await openMarket(db, eventId, now, scope);
    if (marketState(await getMarket(db, eventId, scope)) !== 'open') throw new RuleError('closed', 'That match is decided.');
  }
  await ensureWallet(db, discordId, now);
  const earlier = await myBet(db, eventId, discordId, scope);
  const have = (await balance(db, discordId)) + (earlier?.amount ?? 0);
  if (amount > have) throw new RuleError('poor', `You have ${have} coins.`);
  const statements = [];
  if (earlier) {
    statements.push(db.prepare("INSERT INTO coin_ledger (discord_id, amount, kind, ref, note, created_at) VALUES (?1, ?2, 'refund', ?3, 'Bet changed', ?4)").bind(discordId, earlier.amount, `event:${eventId}`, now));
    statements.push(db.prepare('DELETE FROM coin_bets WHERE id = ?1').bind(earlier.id));
  }
  statements.push(db.prepare("INSERT INTO coin_ledger (discord_id, amount, kind, ref, note, created_at) VALUES (?1, ?2, 'bet', ?3, NULL, ?4)").bind(discordId, -amount, `event:${eventId}`, now));
  statements.push(db.prepare('INSERT INTO coin_bets (event_id, scope, discord_id, pick, amount, placed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(eventId, scope, discordId, pick, amount, now));
  await db.batch(statements);
  return (await myBet(db, eventId, discordId, scope))!;
}

// Taking a bet back while betting is open.
export async function cancelBet(db: D1Database, eventId: number, discordId: string, now: number, scope = WINNER): Promise<Bet | null> {
  const bet = await myBet(db, eventId, discordId, scope);
  if (!bet) return null;
  if (marketState(await getMarket(db, eventId, scope)) !== 'open') throw new RuleError('closed', 'Betting is closed for this one.');
  await db.batch([
    db.prepare("INSERT INTO coin_ledger (discord_id, amount, kind, ref, note, created_at) VALUES (?1, ?2, 'refund', ?3, 'Bet taken back', ?4)").bind(discordId, bet.amount, `event:${eventId}`, now),
    db.prepare('DELETE FROM coin_bets WHERE id = ?1').bind(bet.id),
  ]);
  return bet;
}

// A redraw can drop a participant; the stakes on anyone no longer in
// the bracket go back.
export async function refundStaleBets(db: D1Database, eventId: number, pool: string[], now: number, bracketId: number | null = null): Promise<Bet[]> {
  const stale: Bet[] = [];
  if (marketState(await getMarket(db, eventId)) === 'open') stale.push(...(await listBets(db, eventId)).filter((b) => !pool.includes(b.pick)));
  // A redraw changes every match, so every unsettled stake on one of this bracket's matches goes back.
  if (bracketId !== null) {
    for (const m of await listMarkets(db, eventId)) {
      if (m.settled_at !== null || parseMatchScope(m.scope)?.bracketId !== bracketId) continue;
      stale.push(...(await listBets(db, eventId, m.scope)));
      await db.prepare('DELETE FROM coin_markets WHERE event_id = ?1 AND scope = ?2').bind(eventId, m.scope).run();
    }
  }
  for (const bet of stale) {
    await db.batch([
      db.prepare("INSERT INTO coin_ledger (discord_id, amount, kind, ref, note, created_at) VALUES (?1, ?2, 'refund', ?3, 'The bracket was redrawn', ?4)").bind(bet.discord_id, bet.amount, `event:${eventId}`, now),
      db.prepare('DELETE FROM coin_bets WHERE id = ?1').bind(bet.id),
    ]);
  }
  return stale;
}

export async function odds(db: D1Database, eventId: number, scope = WINNER): Promise<Odds> {
  const bets = await listBets(db, eventId, scope);
  const pool = bets.reduce((n, b) => n + b.amount, 0);
  const by = new Map<string, { staked: number; backers: number }>();
  for (const b of bets) {
    const row = by.get(b.pick) ?? { staked: 0, backers: 0 };
    row.staked += b.amount; row.backers += 1;
    by.set(b.pick, row);
  }
  const picks = [...by.entries()]
    .map(([pick, r]) => ({ pick, ...r, share: pool === 0 ? 0 : r.staked / pool, multiplier: r.staked === 0 ? null : pool / r.staked }))
    .sort((a, b) => b.staked - a.staked);
  return { pool, bets: bets.length, picks };
}

// The final is decided: the pool goes to whoever picked the champion, in
// proportion to their stakes, whole coins each, the odd coin or two lost
// to rounding. Nobody right means everybody's stake comes back. Settling
// twice changes nothing.
export async function settleMarket(db: D1Database, eventId: number, winner: string, now: number, scope = WINNER): Promise<{ payouts: Bet[]; refunded: boolean } | null> {
  const market = await getMarket(db, eventId, scope);
  if (!market || market.settled_at !== null) return null;
  const bets = await listBets(db, eventId, scope);
  const pool = bets.reduce((n, b) => n + b.amount, 0);
  const winners = bets.filter((b) => b.pick === winner);
  const onWinner = winners.reduce((n, b) => n + b.amount, 0);
  const statements = [];
  const payouts: Bet[] = [];
  if (bets.length > 0 && onWinner === 0) {
    for (const b of bets) {
      statements.push(db.prepare("INSERT INTO coin_ledger (discord_id, amount, kind, ref, note, created_at) VALUES (?1, ?2, 'refund', ?3, 'Nobody picked the champion', ?4)").bind(b.discord_id, b.amount, `event:${eventId}`, now));
      statements.push(db.prepare("UPDATE coin_bets SET result = 'refunded', payout = ?2 WHERE id = ?1").bind(b.id, b.amount));
    }
  } else {
    for (const b of bets) {
      if (b.pick === winner) {
        const payout = Math.floor((b.amount * pool) / onWinner);
        statements.push(db.prepare("INSERT INTO coin_ledger (discord_id, amount, kind, ref, note, created_at) VALUES (?1, ?2, 'payout', ?3, 'Picked the champion', ?4)").bind(b.discord_id, payout, `event:${eventId}`, now));
        statements.push(db.prepare("UPDATE coin_bets SET result = 'won', payout = ?2 WHERE id = ?1").bind(b.id, payout));
        payouts.push({ ...b, result: 'won', payout });
      } else {
        statements.push(db.prepare("UPDATE coin_bets SET result = 'lost', payout = 0 WHERE id = ?1").bind(b.id));
      }
    }
  }
  statements.push(db.prepare('UPDATE coin_markets SET settled_at = ?2, closed_at = COALESCE(closed_at, ?2), winner = ?3 WHERE event_id = ?1 AND scope = ?4').bind(eventId, now, winner, scope));
  await db.batch(statements);
  return { payouts, refunded: bets.length > 0 && onWinner === 0 };
}

// The final was reverted: what was paid out comes back, the bets stand
// again, the market is closed but not settled.
export async function unsettleMarket(db: D1Database, eventId: number, now: number, scope = WINNER): Promise<boolean> {
  const market = await getMarket(db, eventId, scope);
  if (!market || market.settled_at === null) return false;
  const statements = [];
  for (const b of await listBets(db, eventId, scope)) {
    if (b.payout > 0) {
      statements.push(db.prepare("INSERT INTO coin_ledger (discord_id, amount, kind, ref, note, created_at) VALUES (?1, ?2, 'unsettle', ?3, 'The final was reverted', ?4)").bind(b.discord_id, -b.payout, `event:${eventId}`, now));
    }
    statements.push(db.prepare('UPDATE coin_bets SET result = NULL, payout = 0 WHERE id = ?1').bind(b.id));
  }
  statements.push(db.prepare('UPDATE coin_markets SET settled_at = NULL, winner = NULL, closed_at = ?3 WHERE event_id = ?1 AND scope = ?2').bind(eventId, scope, scope === WINNER ? market.closed_at : null));
  await db.batch(statements);
  return true;
}

// The keys anyone can bet on: every side drawn into the bracket.
export function bracketKeys(matches: BracketMatch[]): string[] {
  const keys = new Set<string>();
  for (const m of matches) for (const k of [m.side_a, m.side_b]) if (k !== null) keys.add(k);
  return [...keys];
}

// A member's own side in the event, if they play in it: their team, or
// themselves in a solo bracket. Null for a spectator.
export async function ownKey(db: D1Database, eventId: number, discordId: string): Promise<string | null> {
  const mine = (await listSignups(db, eventId)).find((s) => s.discord_id === discordId);
  if (!mine || mine.status !== 'yes') return null;
  return mine.event_team_id !== null ? `t:${mine.event_team_id}` : `u:${discordId}`;
}

// The undecided match a participant is waiting in, if any, as a scope.
export function nextMatchOf(matches: BracketMatch[], bracketId: number, pick: string): { scope: string; match: BracketMatch } | null {
  const match = matches.find((m) => m.winner === null && m.side_a !== null && m.side_b !== null && (m.side_a === pick || m.side_b === pick));
  return match ? { scope: matchScope(bracketId, match.round, match.slot), match } : null;
}

// The event a Discord channel belongs to: its talk channel, or any of the
// channels made for it, so a command there needs no event id.
export async function eventForChannel(db: D1Database, channelId: string): Promise<EventRow | null> {
  const row = await db
    .prepare('SELECT id FROM events WHERE discord_channel_id = ?1 UNION SELECT event_id AS id FROM event_discord_channels WHERE channel_id = ?1 LIMIT 1')
    .bind(channelId)
    .first<{ id: number }>();
  return row ? getEvent(db, row.id) : null;
}

// The lines the event's channel gets.
export function bettingOpenLine(eventId: number, url: string): string {
  return `${COIN} **Betting is open** on who wins the bracket. \`/bet ${eventId} <team or player> <coins>\` here in Discord, or on the event page. Playing in it? You can back your own side only. Stakes lock at the first result. \`/odds ${eventId}\` shows the pool.
${url}`;
}

export function settledLine(o: Odds, result: { payouts: Bet[]; refunded: boolean }, winnerName: string, nameOf: (id: string) => string): string | null {
  if (o.bets === 0) return null;
  if (result.refunded) return `${COIN} Nobody had ${winnerName}: every stake in the pool of ${coins(o.pool)} goes back.`;
  const winners = result.payouts.map((p) => `${nameOf(p.discord_id)} +${p.payout}`).join(', ');
  return `${COIN} The pool of ${coins(o.pool)} goes to the ${result.payouts.length === 1 ? 'one who' : `${result.payouts.length} who`} picked ${winnerName}: ${winners}.`;
}

// --- words ------------------------------------------------------------------------------

export function coins(n: number): string {
  return `${n} ${COIN}`;
}

export function multiplierLabel(m: number | null): string {
  return m === null ? '—' : `${m >= 10 ? Math.round(m) : m.toFixed(1)}×`;
}

// The pool as a list, biggest stake first: "Team A · 120 🪙 from 3 · pays 1.8×".
export function oddsLines(o: Odds, nameOf: (key: string) => string): string[] {
  if (o.bets === 0) return ['No stakes yet.'];
  return o.picks.map((p) => `${nameOf(p.pick)} · ${coins(p.staked)} from ${p.backers} · pays ${multiplierLabel(p.multiplier)}`);
}

export function ledgerLine(row: LedgerRow): string {
  const what: Record<LedgerKind, string> = {
    start: 'Welcome purse', allowance: 'Monthly allowance', activity: 'From battle pass XP', bet: 'Bet', refund: 'Bet returned', payout: 'Winnings', unsettle: 'Winnings taken back', purse: "Champion's purse", grant: 'From the board',
  };
  const sign = row.amount > 0 ? '+' : '';
  return `${sign}${row.amount} ${COIN} · ${row.note && row.kind === 'grant' ? row.note : what[row.kind]}`;
}
