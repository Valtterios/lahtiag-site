// Claims: a member asks for a tick, the board decides. The asking happens
// in Discord (/claim, or the button under /season and the leaderboard);
// the deciding in the board channel, under the line the claim posts
// there, or on the season page. Approving gives the tick like the board
// would by hand, so the caps and the once-per-event rule apply as usual.
// Only kinds the board has marked claimable can be asked for.
import type { D1Database } from '@cloudflare/workers-types';
import { RuleError } from './db';
import { getTickKind, giveTick, listTickKinds, seasonRange, type TickKind, type TickRow } from './ticks';
import { seasonStartYear } from './activity';

export type ClaimStatus = 'pending' | 'approved' | 'declined';

export interface ClaimRow {
  id: number;
  kind_id: number;
  kind: string;
  xp: number; // what the kind pays now
  register_id: number;
  member: string; // the register entry's full name
  discord_id: string;
  event_id: number | null;
  event: string | null;
  note: string | null;
  status: ClaimStatus;
  tick_id: number | null;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
}

export const CLAIM_NOTE_MAX = 200;

const CLAIM_COLUMNS = `c.id, c.kind_id, k.name AS kind, k.xp, c.register_id, r.full_name AS member, c.discord_id,
  c.event_id, e.title AS event, c.note, c.status, c.tick_id, c.created_at, c.decided_by, c.decided_at
  FROM tick_claims c
  JOIN tick_kinds k ON k.id = c.kind_id
  JOIN register r ON r.id = c.register_id
  LEFT JOIN events e ON e.id = c.event_id`;

// The kinds a member may ask for: on the list, not retired, marked claimable.
export async function listClaimableKinds(db: D1Database): Promise<TickKind[]> {
  return (await listTickKinds(db)).filter((k) => k.claimable);
}

export async function getClaim(db: D1Database, id: number): Promise<ClaimRow | null> {
  return db.prepare(`SELECT ${CLAIM_COLUMNS} WHERE c.id = ?1`).bind(id).first<ClaimRow>();
}

export async function createClaim(
  db: D1Database,
  input: { discordId: string; kindId: number; eventId: number | null; note?: unknown },
  now: number,
): Promise<ClaimRow> {
  const kind = await getTickKind(db, input.kindId);
  if (!kind || kind.retired_at !== null || !kind.claimable) throw new RuleError('missing', 'That tick is not open for claims.');
  const member = await db.prepare("SELECT id FROM register WHERE discord_id = ?1 AND status = 'member'").bind(input.discordId).first<{ id: number }>();
  if (!member) throw new RuleError('not_member', 'Claims need a current membership with your Discord account linked to it. `/join` sorts that out.');
  if (input.eventId !== null) {
    const event = await db.prepare('SELECT id FROM events WHERE id = ?1').bind(input.eventId).first<{ id: number }>();
    if (!event) throw new RuleError('missing', 'No such event.');
    const given = await db
      .prepare('SELECT id FROM ticks WHERE kind_id = ?1 AND register_id = ?2 AND event_id = ?3')
      .bind(input.kindId, member.id, input.eventId)
      .first<{ id: number }>();
    if (given) throw new RuleError('duplicate', 'You already have that tick for this event.');
  }
  const waiting = await db
    .prepare("SELECT id FROM tick_claims WHERE kind_id = ?1 AND register_id = ?2 AND event_id IS ?3 AND status = 'pending'")
    .bind(input.kindId, member.id, input.eventId)
    .first<{ id: number }>();
  if (waiting) throw new RuleError('duplicate', 'You already have a claim for that waiting for the board.');
  const note = String(input.note ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CLAIM_NOTE_MAX);
  const result = await db
    .prepare('INSERT INTO tick_claims (kind_id, register_id, discord_id, event_id, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(input.kindId, member.id, input.discordId, input.eventId, note === '' ? null : note, now)
    .run();
  return (await getClaim(db, Number(result.meta.last_row_id)))!;
}

// Waiting for the board, oldest first.
export async function listPendingClaims(db: D1Database): Promise<ClaimRow[]> {
  const { results } = await db.prepare(`SELECT ${CLAIM_COLUMNS} WHERE c.status = 'pending' ORDER BY c.created_at, c.id`).all<ClaimRow>();
  return results;
}

// How many of a member's claims wait for the board this season.
export async function memberPendingClaims(db: D1Database, discordId: string, now: number): Promise<number> {
  const { from, to } = seasonRange(seasonStartYear(now));
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM tick_claims WHERE discord_id = ?1 AND status = 'pending' AND created_at >= ?2 AND created_at < ?3")
    .bind(discordId, from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// The decision. Approving gives the tick (the same rules as by hand: a
// duplicate for the event is refused with a RuleError and the claim stays
// pending); a claim decided before comes back as null.
export async function decideClaim(
  db: D1Database,
  id: number,
  verdict: 'approve' | 'decline',
  by: string,
  now: number,
): Promise<{ claim: ClaimRow; tick: TickRow | null } | null> {
  const claim = await getClaim(db, id);
  if (!claim || claim.status !== 'pending') return null;
  let tick: TickRow | null = null;
  if (verdict === 'approve') {
    tick = await giveTick(db, { kindId: claim.kind_id, registerId: claim.register_id, eventId: claim.event_id, note: claim.note }, by, now);
  }
  await db
    .prepare('UPDATE tick_claims SET status = ?2, tick_id = ?3, decided_by = ?4, decided_at = ?5 WHERE id = ?1')
    .bind(id, verdict === 'approve' ? 'approved' : 'declined', tick?.id ?? null, by, now)
    .run();
  return { claim: (await getClaim(db, id))!, tick };
}

// The line in the board channel, with Approve and Decline under it.
export function claimLine(claim: ClaimRow, origin: string): string {
  const what = `**${claim.kind}**${claim.event ? ` for *${claim.event}*` : ''}`;
  const note = claim.note ? `: “${claim.note}”` : '';
  return `🙋 **Tick claim**: <@${claim.discord_id}> asks for ${what}${note} (${claim.xp} XP). Approve below or at ${origin}/board/season#claims`;
}

// The DM with the decision, from the board channel or the season page.
export function claimDecisionDm(claim: ClaimRow, origin: string): string {
  const what = `**${claim.kind}**${claim.event ? ` for ${claim.event}` : ''}`;
  if (claim.status === 'approved') return `✅ The board approved your claim: ${what}, ${claim.xp} XP. \`/season\` in Discord shows your season, so does ${origin}/membership`;
  return `The board didn't approve your claim for ${what}. Ask a board member if you want to know more.`;
}
