// All D1 access, one exported function per operation (spec, Repository
// layout): a web form, a slash command and a future external bot share this
// one copy of the validation. Routes and command handlers never contain SQL.

import type { D1Database } from '@cloudflare/workers-types';

export class RuleError extends Error {
  constructor(
    public code:
      | 'missing'
      | 'cancelled'
      | 'full'
      | 'started'
      | 'bad_input'
      | 'team_full'
      | 'dup_name'
      | 'not_team_event'
      | 'closed',
    message: string,
  ) {
    super(message);
  }
}

export interface MemberRow {
  discord_id: string;
  username: string;
  avatar_hash: string | null;
}

export interface EventRow {
  id: number;
  title: string;
  description: string | null;
  starts_at: number;
  capacity: number | null; // people on a solo event, TEAMS on a team event
  team_id: number | null; // legacy, unused: organizers replaced it
  team_size: number | null; // set = tournament-style team signups
  organizers: string | null; // comma-separated free-text names
  created_by: string;
  created_at: number;
  cancelled_at: number | null;
  signups_closed_at: number | null;
  discord_message_id: string | null;
}

export interface EventWithCounts extends EventRow {
  yes_count: number;
  maybe_count: number;
  teams_count: number;
}

export interface SignupRow {
  discord_id: string;
  status: 'yes' | 'maybe';
  created_at: number;
  event_team_id: number | null;
  username: string;
  avatar_hash: string | null;
}

export interface EventTeamRow {
  id: number;
  event_id: number;
  name: string;
  created_by: string;
  created_at: number;
}

export interface AnnouncementRow {
  id: number;
  title: string;
  body_md: string;
  published_at: number;
  author_id: string;
  source: 'web' | 'discord';
  discord_message_id: string | null;
  author_name: string | null;
}

// The members table is a display cache, not an account table: written on
// every login and every bot interaction so signup lists can show names for
// people who are not currently logged in.
export async function upsertMember(
  db: D1Database,
  member: MemberRow,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (discord_id, username, avatar_hash, last_seen)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (discord_id) DO UPDATE SET
         username = ?2, avatar_hash = ?3, last_seen = ?4`,
    )
    .bind(member.discord_id, member.username, member.avatar_hash, now)
    .run();
}

// Insert-only variant for rosters: someone added by Discord id may never
// have logged in, but if they have, their real cached name must survive.
export async function ensureMember(
  db: D1Database,
  discordId: string,
  fallbackUsername: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO members (discord_id, username, avatar_hash, last_seen)
       VALUES (?1, ?2, NULL, ?3)`,
    )
    .bind(discordId, fallbackUsername, now)
    .run();
}

const EVENT_COUNTS = `
  SELECT e.*,
    (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status = 'yes')   AS yes_count,
    (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status = 'maybe') AS maybe_count,
    (SELECT COUNT(*) FROM event_teams t WHERE t.event_id = e.id)                    AS teams_count
  FROM events e`;

export async function listUpcomingEvents(db: D1Database, now: number): Promise<EventWithCounts[]> {
  const { results } = await db
    .prepare(`${EVENT_COUNTS} WHERE e.cancelled_at IS NULL AND e.starts_at >= ?1 ORDER BY e.starts_at ASC`)
    .bind(now)
    .all<EventWithCounts>();
  return results;
}

export async function listPastEvents(
  db: D1Database,
  now: number,
  limit = 10,
): Promise<EventWithCounts[]> {
  const { results } = await db
    .prepare(
      `${EVENT_COUNTS} WHERE e.cancelled_at IS NULL AND e.starts_at < ?1 ORDER BY e.starts_at DESC LIMIT ?2`,
    )
    .bind(now, limit)
    .all<EventWithCounts>();
  return results;
}

export async function getEvent(db: D1Database, id: number): Promise<EventWithCounts | null> {
  return db.prepare(`${EVENT_COUNTS} WHERE e.id = ?1`).bind(id).first<EventWithCounts>();
}

export async function createEvent(
  db: D1Database,
  input: {
    title: string;
    description: string | null;
    starts_at: number;
    capacity: number | null;
    team_size?: number | null;
    organizers?: string | null;
    created_by: string;
  },
  now: number,
): Promise<number> {
  if (!input.title.trim()) throw new RuleError('bad_input', 'An event needs a title.');
  if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    throw new RuleError('bad_input', 'Capacity must be a positive whole number.');
  }
  const teamSize = input.team_size ?? null;
  if (teamSize !== null && (!Number.isInteger(teamSize) || teamSize < 1)) {
    throw new RuleError('bad_input', 'Team size must be a positive whole number.');
  }
  const organizers = input.organizers?.trim() || null;
  const row = await db
    .prepare(
      `INSERT INTO events (title, description, starts_at, capacity, team_size, organizers, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
    )
    .bind(
      input.title.trim(),
      input.description,
      input.starts_at,
      input.capacity,
      teamSize,
      organizers,
      input.created_by,
      now,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function cancelEvent(db: D1Database, id: number, now: number): Promise<EventRow> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'Already cancelled.');
  await db.prepare('UPDATE events SET cancelled_at = ?1 WHERE id = ?2').bind(now, id).run();
  return event;
}

export async function setEventMessageId(db: D1Database, id: number, messageId: string): Promise<void> {
  await db.prepare('UPDATE events SET discord_message_id = ?1 WHERE id = ?2').bind(messageId, id).run();
}

// The signup rules (spec, Error handling): rejected when the event is
// cancelled or full. Capacity counts 'yes' answers only, and changing your
// own existing answer never counts you twice. On a TEAM event capacity
// counts teams instead, so plain signups (free agents) never hit it, and
// answering yes/maybe here always drops any team membership — joining a
// team goes through joinEventTeam.
export async function setSignup(
  db: D1Database,
  eventId: number,
  discordId: string,
  status: 'yes' | 'maybe',
  now: number,
): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'This event is cancelled.');
  if (event.signups_closed_at !== null) throw new RuleError('closed', 'Signups are closed.');
  if (status === 'yes' && event.capacity !== null && event.team_size === null) {
    const taken = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND status = 'yes' AND discord_id != ?2`,
      )
      .bind(eventId, discordId)
      .first<{ n: number }>();
    if ((taken?.n ?? 0) >= event.capacity) throw new RuleError('full', 'This event is full.');
  }
  await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id)
       VALUES (?1, ?2, ?3, ?4, NULL)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = ?3, event_team_id = NULL`,
    )
    .bind(eventId, discordId, status, now)
    .run();
  if (event.team_size !== null) await dropEmptyEventTeams(db, eventId);
}

export async function removeSignup(db: D1Database, eventId: number, discordId: string): Promise<void> {
  const event = await getEvent(db, eventId);
  if (event?.signups_closed_at != null) throw new RuleError('closed', 'Signups are closed.');
  await db
    .prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .run();
  await dropEmptyEventTeams(db, eventId);
}

export async function setSignupsClosed(
  db: D1Database,
  eventId: number,
  closed: boolean,
  now: number,
): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  await db
    .prepare('UPDATE events SET signups_closed_at = ?2 WHERE id = ?1')
    .bind(eventId, closed ? now : null)
    .run();
}

// --- tournament team signups -----------------------------------------------

async function requireOpenTeamEvent(db: D1Database, eventId: number): Promise<EventWithCounts> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'This event is cancelled.');
  if (event.signups_closed_at !== null) throw new RuleError('closed', 'Signups are closed.');
  if (event.team_size === null) {
    throw new RuleError('not_team_event', 'This event does not take team signups.');
  }
  return event;
}

// A team with no members left is deleted rather than lingering as an empty
// name squatting on the roster (and, on capped events, on a team slot).
async function dropEmptyEventTeams(db: D1Database, eventId: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM event_teams WHERE event_id = ?1 AND id NOT IN
        (SELECT event_team_id FROM signups WHERE event_id = ?1 AND event_team_id IS NOT NULL)`,
    )
    .bind(eventId)
    .run();
}

export async function listEventTeams(db: D1Database, eventId: number): Promise<EventTeamRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM event_teams WHERE event_id = ?1 ORDER BY created_at ASC')
    .bind(eventId)
    .all<EventTeamRow>();
  return results;
}

// Creating a team also joins it: a team's founder is its first member.
export async function createEventTeam(
  db: D1Database,
  eventId: number,
  name: string,
  discordId: string,
  now: number,
): Promise<number> {
  const event = await requireOpenTeamEvent(db, eventId);
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 40) {
    throw new RuleError('bad_input', 'A team name is 1 to 40 characters.');
  }
  if (event.capacity !== null) {
    const teams = await db
      .prepare('SELECT COUNT(*) AS n FROM event_teams WHERE event_id = ?1')
      .bind(eventId)
      .first<{ n: number }>();
    if ((teams?.n ?? 0) >= event.capacity) {
      throw new RuleError('full', 'All team slots for this event are taken.');
    }
  }
  const duplicate = await db
    .prepare('SELECT id FROM event_teams WHERE event_id = ?1 AND name = ?2 COLLATE NOCASE')
    .bind(eventId, trimmed)
    .first();
  if (duplicate) throw new RuleError('dup_name', 'A team with that name already exists.');
  const row = await db
    .prepare(
      `INSERT INTO event_teams (event_id, name, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4) RETURNING id`,
    )
    .bind(eventId, trimmed, discordId, now)
    .first<{ id: number }>();
  await joinEventTeam(db, eventId, row!.id, discordId, now);
  return row!.id;
}

export async function joinEventTeam(
  db: D1Database,
  eventId: number,
  eventTeamId: number,
  discordId: string,
  now: number,
): Promise<void> {
  const event = await requireOpenTeamEvent(db, eventId);
  const team = await db
    .prepare('SELECT * FROM event_teams WHERE id = ?1 AND event_id = ?2')
    .bind(eventTeamId, eventId)
    .first<EventTeamRow>();
  if (!team) throw new RuleError('missing', 'No such team on this event.');
  const members = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM signups
       WHERE event_id = ?1 AND event_team_id = ?2 AND discord_id != ?3`,
    )
    .bind(eventId, eventTeamId, discordId)
    .first<{ n: number }>();
  if ((members?.n ?? 0) >= event.team_size!) {
    throw new RuleError('team_full', 'That team is already full.');
  }
  await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id)
       VALUES (?1, ?2, 'yes', ?3, ?4)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = 'yes', event_team_id = ?4`,
    )
    .bind(eventId, discordId, now, eventTeamId)
    .run();
  // Switching teams may have emptied the previous one.
  await dropEmptyEventTeams(db, eventId);
}

// Leaving a team keeps the member signed up as a free agent.
export async function leaveEventTeam(db: D1Database, eventId: number, discordId: string): Promise<void> {
  const event = await getEvent(db, eventId);
  if (event?.signups_closed_at != null) throw new RuleError('closed', 'Signups are closed.');
  await db
    .prepare(
      'UPDATE signups SET event_team_id = NULL WHERE event_id = ?1 AND discord_id = ?2',
    )
    .bind(eventId, discordId)
    .run();
  await dropEmptyEventTeams(db, eventId);
}

export async function listSignups(db: D1Database, eventId: number): Promise<SignupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.discord_id, s.status, s.created_at, s.event_team_id, m.username, m.avatar_hash
       FROM signups s JOIN members m ON m.discord_id = s.discord_id
       WHERE s.event_id = ?1
       ORDER BY s.created_at ASC`,
    )
    .bind(eventId)
    .all<SignupRow>();
  return results;
}

// --- tournament brackets ---------------------------------------------------
// Single elimination. Participant keys: 'u:<discord_id>' / 't:<event_team_id>'.

export interface BracketMatch {
  event_id: number;
  round: number;
  slot: number;
  side_a: string | null;
  side_b: string | null;
  winner: string | null;
}

export async function getBracket(db: D1Database, eventId: number): Promise<BracketMatch[]> {
  const { results } = await db
    .prepare('SELECT * FROM bracket_matches WHERE event_id = ?1 ORDER BY round, slot')
    .bind(eventId)
    .all<BracketMatch>();
  return results;
}

export async function deleteBracket(db: D1Database, eventId: number): Promise<void> {
  await db.prepare('DELETE FROM bracket_matches WHERE event_id = ?1').bind(eventId).run();
}

async function getMatch(db: D1Database, eventId: number, round: number, slot: number) {
  return db
    .prepare('SELECT * FROM bracket_matches WHERE event_id = ?1 AND round = ?2 AND slot = ?3')
    .bind(eventId, round, slot)
    .first<BracketMatch>();
}

// Removes a participant from every later-round position it had advanced to;
// used when an earlier result changes so stale progress never lingers.
async function removeFromDownstream(
  db: D1Database,
  eventId: number,
  round: number,
  slot: number,
  key: string,
  totalRounds: number,
): Promise<void> {
  if (round >= totalRounds) return;
  const nextRound = round + 1;
  const nextSlot = slot >> 1;
  const side = slot % 2 === 0 ? 'side_a' : 'side_b';
  const match = await getMatch(db, eventId, nextRound, nextSlot);
  if (!match || match[side as 'side_a' | 'side_b'] !== key) return;
  await db
    .prepare(
      `UPDATE bracket_matches SET ${side} = NULL, winner = CASE WHEN winner = ?4 THEN NULL ELSE winner END
       WHERE event_id = ?1 AND round = ?2 AND slot = ?3`,
    )
    .bind(eventId, nextRound, nextSlot, key)
    .run();
  await removeFromDownstream(db, eventId, nextRound, nextSlot, key, totalRounds);
}

// Places `key` on its side of the next-round match, evicting (and cascading
// away) whoever a changed result had put there before.
async function advance(
  db: D1Database,
  eventId: number,
  round: number,
  slot: number,
  key: string,
  totalRounds: number,
): Promise<void> {
  if (round >= totalRounds) return;
  const nextRound = round + 1;
  const nextSlot = slot >> 1;
  const side = slot % 2 === 0 ? 'side_a' : 'side_b';
  const match = await getMatch(db, eventId, nextRound, nextSlot);
  if (!match) return;
  const occupant = match[side as 'side_a' | 'side_b'];
  if (occupant === key) return;
  await db
    .prepare(
      `UPDATE bracket_matches SET ${side} = ?4, winner = CASE WHEN winner = ?5 THEN NULL ELSE winner END
       WHERE event_id = ?1 AND round = ?2 AND slot = ?3`,
    )
    .bind(eventId, nextRound, nextSlot, key, occupant ?? '')
    .run();
  if (occupant) await removeFromDownstream(db, eventId, nextRound, nextSlot, occupant, totalRounds);
}

// Builds the whole bracket from the event's current participants: full
// 'yes' signups on a solo event, formed teams on a team event. Replaces any
// existing bracket. Byes auto-advance immediately.
export async function generateBracket(db: D1Database, eventId: number): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);

  let keys: string[];
  if (event.team_size !== null) {
    keys = (await listEventTeams(db, eventId)).map((team) => `t:${team.id}`);
  } else {
    keys = (await listSignups(db, eventId))
      .filter((signup) => signup.status === 'yes')
      .map((signup) => `u:${signup.discord_id}`);
  }
  if (keys.length < 2) {
    throw new RuleError('bad_input', 'A bracket needs at least two participants.');
  }

  // Random seeding.
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }

  let size = 1;
  while (size < keys.length) size *= 2;
  const totalRounds = Math.log2(size);

  await deleteBracket(db, eventId);

  // Spread byes one per match from the end, so no match is a double bye.
  const matches: Array<[string | null, string | null]> = [];
  const byes = size - keys.length;
  let cursor = 0;
  for (let slot = 0; slot < size / 2; slot++) {
    const hasBye = slot >= size / 2 - byes;
    const a = keys[cursor++];
    const b = hasBye ? null : keys[cursor++];
    matches.push([a, b]);
  }

  const statements = [];
  for (let slot = 0; slot < size / 2; slot++) {
    const [a, b] = matches[slot];
    statements.push(
      db
        .prepare(
          `INSERT INTO bracket_matches (event_id, round, slot, side_a, side_b, winner)
           VALUES (?1, 1, ?2, ?3, ?4, NULL)`,
        )
        .bind(eventId, slot, a, b),
    );
  }
  for (let round = 2; round <= totalRounds; round++) {
    for (let slot = 0; slot < size / 2 ** round; slot++) {
      statements.push(
        db
          .prepare(
            `INSERT INTO bracket_matches (event_id, round, slot, side_a, side_b, winner)
             VALUES (?1, ?2, ?3, NULL, NULL, NULL)`,
          )
          .bind(eventId, round, slot),
      );
    }
  }
  await db.batch(statements);

  // Byes advance on the spot.
  for (let slot = 0; slot < size / 2; slot++) {
    const [a, b] = matches[slot];
    if (a !== null && b === null) {
      await db
        .prepare(
          'UPDATE bracket_matches SET winner = ?4 WHERE event_id = ?1 AND round = 1 AND slot = ?2 AND side_a = ?3',
        )
        .bind(eventId, slot, a, a)
        .run();
      await advance(db, eventId, 1, slot, a, totalRounds);
    }
  }
}

export async function setBracketWinner(
  db: D1Database,
  eventId: number,
  round: number,
  slot: number,
  winnerKey: string,
): Promise<void> {
  const match = await getMatch(db, eventId, round, slot);
  if (!match) throw new RuleError('missing', 'No such match.');
  if (match.side_a === null || match.side_b === null) {
    throw new RuleError('bad_input', 'Both sides of the match must be known first.');
  }
  if (winnerKey !== match.side_a && winnerKey !== match.side_b) {
    throw new RuleError('bad_input', 'The winner must be one of the two sides.');
  }
  if (match.winner === winnerKey) return;
  const totals = await db
    .prepare('SELECT MAX(round) AS n FROM bracket_matches WHERE event_id = ?1')
    .bind(eventId)
    .first<{ n: number }>();
  const totalRounds = totals!.n;
  await db
    .prepare(
      'UPDATE bracket_matches SET winner = ?4 WHERE event_id = ?1 AND round = ?2 AND slot = ?3',
    )
    .bind(eventId, round, slot, winnerKey)
    .run();
  await advance(db, eventId, round, slot, winnerKey, totalRounds);
}

export async function listAnnouncements(db: D1Database, limit = 20): Promise<AnnouncementRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, m.username AS author_name
       FROM announcements a LEFT JOIN members m ON m.discord_id = a.author_id
       ORDER BY a.published_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<AnnouncementRow>();
  return results;
}

// Returns the deleted row so the caller can also remove the mirrored
// Discord message (deleting the Discord message by hand does NOT reach the
// site — nothing listens for deletions — so the site is the place to
// delete, and it cleans up Discord too).
export async function deleteAnnouncement(
  db: D1Database,
  id: number,
): Promise<AnnouncementRow | null> {
  const row = await db
    .prepare('SELECT a.*, NULL AS author_name FROM announcements a WHERE id = ?1')
    .bind(id)
    .first<AnnouncementRow>();
  if (!row) return null;
  await db.prepare('DELETE FROM announcements WHERE id = ?1').bind(id).run();
  return row;
}

export async function createAnnouncement(
  db: D1Database,
  input: { title: string; body_md: string; author_id: string; source: 'web' | 'discord' },
  now: number,
): Promise<number> {
  if (!input.title.trim() || !input.body_md.trim()) {
    throw new RuleError('bad_input', 'An announcement needs a title and a body.');
  }
  const row = await db
    .prepare(
      `INSERT INTO announcements (title, body_md, published_at, author_id, source)
       VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
    )
    .bind(input.title.trim(), input.body_md, now, input.author_id, input.source)
    .first<{ id: number }>();
  return row!.id;
}

export async function setAnnouncementMessageId(
  db: D1Database,
  id: number,
  messageId: string,
): Promise<void> {
  await db
    .prepare('UPDATE announcements SET discord_message_id = ?1 WHERE id = ?2')
    .bind(messageId, id)
    .run();
}
