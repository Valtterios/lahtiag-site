// All D1 access, one exported function per operation (spec, Repository
// layout): a web form, a slash command and a future external bot share this
// one copy of the validation. Routes and command handlers never contain SQL.

import type { D1Database } from '@cloudflare/workers-types';
import type { ApplicationInput, MemberType, RegisterStatus } from './register';
import { deriveMemberType, searchKey } from './register';

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
      | 'closed'
      | 'duplicate',
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
  ends_at: number | null;
  capacity: number | null; // people on a solo event, TEAMS on a team event
  team_id: number | null; // legacy, unused: organizers replaced it
  team_size: number | null; // set = tournament-style team signups
  organizers: string | null; // comma-separated free-text names
  link_url: string | null; // optional stream/info link
  display_note: string | null; // live message for the venue display
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
  is_member: number; // 1 = linked to a current entry in the member register
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
    .prepare(
      `${EVENT_COUNTS} WHERE e.cancelled_at IS NULL
       AND (e.starts_at >= ?1 OR (e.ends_at IS NOT NULL AND e.ends_at > ?1))
       ORDER BY e.starts_at ASC`,
    )
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
      `${EVENT_COUNTS} WHERE e.cancelled_at IS NULL AND e.starts_at < ?1
       AND (e.ends_at IS NULL OR e.ends_at <= ?1)
       ORDER BY e.starts_at DESC LIMIT ?2`,
    )
    .bind(now, limit)
    .all<EventWithCounts>();
  return results;
}

export async function getEvent(db: D1Database, id: number): Promise<EventWithCounts | null> {
  return db.prepare(`${EVENT_COUNTS} WHERE e.id = ?1`).bind(id).first<EventWithCounts>();
}

// Server-side length caps: the forms carry maxlength and Discord's modals
// cap their fields, but neither binds a hand-crafted POST.
function capLength(value: string | null, max: number, what: string): void {
  if (value !== null && value.length > max) {
    throw new RuleError('bad_input', `${what} is at most ${max} characters.`);
  }
}

function checkEventText(input: {
  title: string;
  description: string | null;
  organizers?: string | null;
}): void {
  capLength(input.title.trim(), 120, 'A title');
  capLength(input.description, 2000, 'A description');
  capLength(input.organizers ?? null, 120, 'The organizers line');
}

// Optional external link: http(s) only, nothing else renders as an href.
function normalizeLink(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\/\S+$/.test(trimmed) || trimmed.length > 300) {
    throw new RuleError('bad_input', 'The link must be an http(s) URL.');
  }
  return trimmed;
}

export async function createEvent(
  db: D1Database,
  input: {
    title: string;
    description: string | null;
    starts_at: number;
    ends_at?: number | null;
    capacity: number | null;
    team_size?: number | null;
    organizers?: string | null;
    link_url?: string | null;
    created_by: string;
  },
  now: number,
): Promise<number> {
  if (!input.title.trim()) throw new RuleError('bad_input', 'An event needs a title.');
  checkEventText(input);
  if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    throw new RuleError('bad_input', 'Capacity must be a positive whole number.');
  }
  const teamSize = input.team_size ?? null;
  if (teamSize !== null && (!Number.isInteger(teamSize) || teamSize < 1)) {
    throw new RuleError('bad_input', 'Team size must be a positive whole number.');
  }
  const organizers = input.organizers?.trim() || null;
  const endsAt = input.ends_at ?? null;
  if (endsAt !== null && endsAt <= input.starts_at) {
    throw new RuleError('bad_input', 'The end must be after the start.');
  }
  const linkUrl = normalizeLink(input.link_url);
  const row = await db
    .prepare(
      `INSERT INTO events (title, description, starts_at, ends_at, capacity, team_size, organizers, link_url, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`,
    )
    .bind(
      input.title.trim(),
      input.description,
      input.starts_at,
      endsAt,
      input.capacity,
      teamSize,
      organizers,
      linkUrl,
      input.created_by,
      now,
    )
    .first<{ id: number }>();
  return row!.id;
}

// Everything except team_size is editable: changing the shape of team
// signups under existing teams would corrupt them, so that one is fixed at
// creation. Signups survive edits; a capacity lowered below the current
// count keeps existing signups and only blocks new ones.
export async function updateEvent(
  db: D1Database,
  id: number,
  input: {
    title: string;
    description: string | null;
    starts_at: number;
    ends_at: number | null;
    capacity: number | null;
    organizers: string | null;
    link_url: string | null;
  },
): Promise<EventWithCounts> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'This event is cancelled.');
  if (!input.title.trim()) throw new RuleError('bad_input', 'An event needs a title.');
  checkEventText(input);
  if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    throw new RuleError('bad_input', 'Capacity must be a positive whole number.');
  }
  if (input.ends_at !== null && input.ends_at <= input.starts_at) {
    throw new RuleError('bad_input', 'The end must be after the start.');
  }
  await db
    .prepare(
      `UPDATE events SET title = ?2, description = ?3, starts_at = ?4, ends_at = ?5, capacity = ?6, organizers = ?7, link_url = ?8
       WHERE id = ?1`,
    )
    .bind(
      id,
      input.title.trim(),
      input.description,
      input.starts_at,
      input.ends_at,
      input.capacity,
      input.organizers?.trim() || null,
      normalizeLink(input.link_url),
    )
    .run();
  return (await getEvent(db, id))!;
}

export async function cancelEvent(db: D1Database, id: number, now: number): Promise<EventRow> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'Already cancelled.');
  await db.prepare('UPDATE events SET cancelled_at = ?1 WHERE id = ?2').bind(now, id).run();
  return event;
}

// Full removal: the event and everything hanging off it (signups, ad-hoc
// teams, bracket). Returns the deleted row so the caller can also remove
// the Discord announcement. Cancel hides an event; delete erases it.
export async function deleteEvent(db: D1Database, id: number): Promise<EventRow> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  await db.batch([
    db.prepare('DELETE FROM bracket_matches WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM signups WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM event_teams WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM events WHERE id = ?1').bind(id),
  ]);
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

export async function setDisplayNote(
  db: D1Database,
  eventId: number,
  note: string | null,
): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  capLength(note, 200, 'A screen message');
  await db.prepare('UPDATE events SET display_note = ?2 WHERE id = ?1').bind(eventId, note).run();
}

// Admin roster edit: change a signup's answer or move it between teams.
// Skips the signups-closed and capacity guards (fixing the roster on
// tournament day is exactly a closed-signups activity), but a team's size
// limit still holds. Picking a team implies 'yes': team members are always
// going, and 'maybe' always means no team.
export async function adminUpdateSignup(
  db: D1Database,
  eventId: number,
  discordId: string,
  status: 'yes' | 'maybe',
  eventTeamId: number | null,
): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const existing = await db
    .prepare('SELECT 1 AS x FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .first();
  if (!existing) throw new RuleError('missing', 'No such signup on this event.');
  let teamId = eventTeamId;
  if (teamId !== null) {
    if (event.team_size === null) {
      throw new RuleError('not_team_event', 'This event does not take team signups.');
    }
    const team = await db
      .prepare('SELECT id FROM event_teams WHERE id = ?1 AND event_id = ?2')
      .bind(teamId, eventId)
      .first();
    if (!team) throw new RuleError('missing', 'No such team on this event.');
    const members = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM signups
         WHERE event_id = ?1 AND event_team_id = ?2 AND discord_id != ?3`,
      )
      .bind(eventId, teamId, discordId)
      .first<{ n: number }>();
    if ((members?.n ?? 0) >= event.team_size) {
      throw new RuleError('team_full', 'That team is already full.');
    }
    status = 'yes';
  } else if (status === 'maybe') {
    teamId = null;
  }
  await db
    .prepare(
      'UPDATE signups SET status = ?3, event_team_id = ?4 WHERE event_id = ?1 AND discord_id = ?2',
    )
    .bind(eventId, discordId, status, teamId)
    .run();
  await dropEmptyEventTeams(db, eventId);
}

// Walk-in participants without Discord: a synthetic member row plus a
// signup, admin-only. The id is "manual-<random hex>", which can never
// collide with a Discord snowflake (those are all digits), and everything
// downstream (brackets, purge, removal) already works by id string. Closed
// signups and capacity don't apply; a team's size limit still does.
export async function addManualParticipant(
  db: D1Database,
  eventId: number,
  name: string,
  status: 'yes' | 'maybe',
  eventTeamId: number | null,
  now: number,
): Promise<string> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) {
    throw new RuleError('bad_input', 'A participant name is 1 to 60 characters.');
  }
  if (eventTeamId !== null) {
    if (event.team_size === null) {
      throw new RuleError('not_team_event', 'This event does not take team signups.');
    }
    const team = await db
      .prepare('SELECT id FROM event_teams WHERE id = ?1 AND event_id = ?2')
      .bind(eventTeamId, eventId)
      .first();
    if (!team) throw new RuleError('missing', 'No such team on this event.');
    const members = await db
      .prepare('SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND event_team_id = ?2')
      .bind(eventId, eventTeamId)
      .first<{ n: number }>();
    if ((members?.n ?? 0) >= event.team_size) {
      throw new RuleError('team_full', 'That team is already full.');
    }
    status = 'yes';
  }
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const discordId = `manual-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  await db
    .prepare(
      `INSERT INTO members (discord_id, username, avatar_hash, last_seen)
       VALUES (?1, ?2, NULL, ?3)`,
    )
    .bind(discordId, trimmed, now)
    .run();
  await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(eventId, discordId, status, now, eventTeamId)
    .run();
  return discordId;
}

// Admin removal skips the signups-closed guard: pruning a no-show or a
// banned member off the roster is exactly a closed-signups activity.
export async function adminRemoveSignup(
  db: D1Database,
  eventId: number,
  discordId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .run();
  await dropEmptyEventTeams(db, eventId);
}

// Erase a member everywhere: every signup and team membership goes, empty
// teams disband, and the cached member row is deleted — or anonymized when
// foreign keys still need it (they created events, teams, or announcements).
// Bracket history keeps the slot but renders as Unknown. This is both the
// ban cleanup and the GDPR-erasure path.
export async function purgeMember(db: D1Database, discordId: string): Promise<'deleted' | 'anonymized'> {
  const { results: affected } = await db
    .prepare('SELECT DISTINCT event_id AS id FROM signups WHERE discord_id = ?1')
    .bind(discordId)
    .all<{ id: number }>();
  await db.prepare('DELETE FROM signups WHERE discord_id = ?1').bind(discordId).run();
  for (const row of affected) await dropEmptyEventTeams(db, row.id);
  try {
    await db.prepare('DELETE FROM members WHERE discord_id = ?1').bind(discordId).run();
    return 'deleted';
  } catch {
    await db
      .prepare("UPDATE members SET username = 'Deleted member', avatar_hash = NULL WHERE discord_id = ?1")
      .bind(discordId)
      .run();
    return 'anonymized';
  }
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
      `SELECT s.discord_id, s.status, s.created_at, s.event_team_id, m.username, m.avatar_hash,
         EXISTS (SELECT 1 FROM register r
                 WHERE r.discord_id = s.discord_id AND r.status = 'member') AS is_member
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

// Reverts a recorded result: the match becomes undecided again and the
// former winner is pulled back out of every later round it had advanced to
// (including any results it won there, cascading). Bye "results" are
// automatic, not recorded, so a match missing a side cannot be reverted.
export async function clearBracketWinner(
  db: D1Database,
  eventId: number,
  round: number,
  slot: number,
): Promise<void> {
  const match = await getMatch(db, eventId, round, slot);
  if (!match) throw new RuleError('missing', 'No such match.');
  if (match.side_a === null || match.side_b === null) {
    throw new RuleError('bad_input', 'A bye cannot be reverted.');
  }
  if (match.winner === null) return;
  const totals = await db
    .prepare('SELECT MAX(round) AS n FROM bracket_matches WHERE event_id = ?1')
    .bind(eventId)
    .first<{ n: number }>();
  const key = match.winner;
  await db
    .prepare(
      'UPDATE bracket_matches SET winner = NULL WHERE event_id = ?1 AND round = ?2 AND slot = ?3',
    )
    .bind(eventId, round, slot)
    .run();
  await removeFromDownstream(db, eventId, round, slot, key, totals!.n);
}

// Decided finals, newest first — the results archive. The champion is
// resolved to a display name plus the avatars to show (team members' for a
// team champion, the player's own otherwise).
export interface ResultRow {
  event_id: number;
  title: string;
  starts_at: number;
  champion_name: string;
  avatars: { discord_id: string; avatar_hash: string | null }[];
}

export async function listResults(db: D1Database, limit = 20): Promise<ResultRow[]> {
  const { results: finals } = await db
    .prepare(
      `SELECT bm.event_id, bm.winner, e.title, e.starts_at
       FROM bracket_matches bm
       JOIN events e ON e.id = bm.event_id
       WHERE bm.winner IS NOT NULL
         AND e.cancelled_at IS NULL
         AND bm.round = (SELECT MAX(round) FROM bracket_matches b2 WHERE b2.event_id = bm.event_id)
       ORDER BY e.starts_at DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ event_id: number; winner: string; title: string; starts_at: number }>();

  const rows: ResultRow[] = [];
  for (const final of finals) {
    if (final.winner.startsWith('t:')) {
      const teamId = Number(final.winner.slice(2));
      const team = await db
        .prepare('SELECT name FROM event_teams WHERE id = ?1')
        .bind(teamId)
        .first<{ name: string }>();
      const { results: members } = await db
        .prepare(
          `SELECT m.discord_id, m.avatar_hash FROM signups s
           JOIN members m ON m.discord_id = s.discord_id
           WHERE s.event_id = ?1 AND s.event_team_id = ?2`,
        )
        .bind(final.event_id, teamId)
        .all<{ discord_id: string; avatar_hash: string | null }>();
      rows.push({
        event_id: final.event_id,
        title: final.title,
        starts_at: final.starts_at,
        champion_name: team?.name ?? 'Unknown team',
        avatars: members,
      });
    } else {
      const discordId = final.winner.slice(2);
      const member = await db
        .prepare('SELECT username, avatar_hash FROM members WHERE discord_id = ?1')
        .bind(discordId)
        .first<{ username: string; avatar_hash: string | null }>();
      rows.push({
        event_id: final.event_id,
        title: final.title,
        starts_at: final.starts_at,
        champion_name: member?.username ?? 'Unknown',
        avatars: member ? [{ discord_id: discordId, avatar_hash: member.avatar_hash }] : [],
      });
    }
  }
  return rows;
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
  capLength(input.title.trim(), 120, 'A title');
  capLength(input.body_md, 4000, 'An announcement body');
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

// --- member register -------------------------------------------------------
// The association's legal member list (migration 0006). Separate from the
// `members` Discord cache: `discord_id` here is an optional link between
// the two. Validation of the fields themselves is in register.ts; these
// functions enforce the rules that need the database (uniqueness, status
// transitions).

export interface RegisterRow extends ApplicationInput {
  id: number;
  member_type: MemberType;
  discord_id: string | null;
  link_discord_id: string | null; // a pending request to link this Discord account
  link_discord_name: string | null;
  link_requested_at: number | null;
  is_active: boolean; // board-approved active (wants_active is the request)
  active_since: number | null;
  active_by: string | null;
  board_note: string | null;
  status: RegisterStatus;
  source: 'web' | 'import' | 'board';
  applied_at: number;
  consented_at: number;
  decided_at: number | null;
  decided_by: string | null;
  updated_at: number;
}

interface RegisterDbRow extends Omit<RegisterRow, 'wants_active' | 'is_active'> {
  wants_active: number;
  is_active: number;
}

function fromDb(row: RegisterDbRow): RegisterRow {
  return { ...row, wants_active: row.wants_active === 1, is_active: row.is_active === 1 };
}

// A public application. One row per email and per linked Discord account:
// a second application with either is refused rather than overwriting the
// first, so nobody can rewrite someone else's entry by knowing their email.
export async function applyForMembership(
  db: D1Database,
  input: ApplicationInput,
  discordId: string | null,
  now: number,
): Promise<number> {
  const clash = await db
    .prepare(
      `SELECT id FROM register
       WHERE email = ?1 COLLATE NOCASE OR (?2 IS NOT NULL AND discord_id = ?2)
       LIMIT 1`,
    )
    .bind(input.email, discordId)
    .first();
  if (clash) throw new RuleError('duplicate', 'This email or Discord account is already in the register.');
  const result = await db
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member,
         member_type, telegram, discord_name, discord_id, games, wants_active, message,
         status, source, applied_at, consented_at, updated_at, search_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', 'web', ?13, ?13, ?13, ?14)
       RETURNING id`,
    )
    .bind(
      input.full_name,
      input.domicile,
      input.email,
      input.student_status,
      input.union_member,
      deriveMemberType(input.student_status),
      input.telegram,
      input.discord_name,
      discordId,
      input.games,
      input.wants_active ? 1 : 0,
      input.message,
      now,
      searchKey([input.full_name, input.email, input.discord_name, input.telegram]),
    )
    .first<{ id: number }>();
  return result!.id;
}

export async function getRegisterEntry(db: D1Database, id: number): Promise<RegisterRow | null> {
  const row = await db.prepare('SELECT * FROM register WHERE id = ?1').bind(id).first<RegisterDbRow>();
  return row ? fromDb(row) : null;
}

// What a signed-in person sees about themselves on /join.
export async function getRegisterByDiscord(
  db: D1Database,
  discordId: string,
): Promise<RegisterRow | null> {
  const row = await db
    .prepare('SELECT * FROM register WHERE discord_id = ?1')
    .bind(discordId)
    .first<RegisterDbRow>();
  return row ? fromDb(row) : null;
}

export interface RegisterFilter {
  status?: RegisterStatus | 'all';
  q?: string;
  activesOnly?: boolean;
  limit?: number;
}

// The board's list. `q` matches name, email, and the two handles. LIKE is
// ASCII-case-insensitive only (ä/Ä differ); good enough for a search box.
export async function listRegister(db: D1Database, filter: RegisterFilter = {}): Promise<RegisterRow[]> {
  const clauses: string[] = [];
  const binds: (string | number)[] = [];
  const status = filter.status ?? 'all';
  if (status !== 'all') {
    binds.push(status);
    clauses.push(`status = ?${binds.length}`);
  }
  if (filter.activesOnly) clauses.push('is_active = 1');
  const q = searchKey([filter.q ?? '']).trim();
  if (q) {
    binds.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    clauses.push(`search_key LIKE ?${binds.length} ESCAPE '\\'`);
  }
  binds.push(filter.limit ?? 1000);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT * FROM register ${where}
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
                full_name COLLATE NOCASE ASC
       LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<RegisterDbRow>();
  return results.map(fromDb);
}

export async function registerCounts(
  db: D1Database,
): Promise<Record<RegisterStatus, number>> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM register GROUP BY status')
    .all<{ status: RegisterStatus; n: number }>();
  const counts: Record<RegisterStatus, number> = { pending: 0, member: 0, former: 0 };
  for (const row of results) counts[row.status] = row.n;
  return counts;
}

// The board's decision on a pending application. Approve records who
// (the deciding board member's Workspace email) and when; reject deletes
// the row, since a refused applicant's data has no reason to stay.
export async function decideApplication(
  db: D1Database,
  id: number,
  decision: 'approve' | 'reject',
  deciderId: string,
  now: number,
): Promise<void> {
  const entry = await getRegisterEntry(db, id);
  if (!entry || entry.status !== 'pending') {
    throw new RuleError('missing', 'No pending application with that id.');
  }
  if (decision === 'reject') {
    await db.prepare('DELETE FROM register WHERE id = ?1').bind(id).run();
    return;
  }
  await db
    .prepare(
      `UPDATE register SET status = 'member', decided_at = ?2, decided_by = ?3, updated_at = ?2
       WHERE id = ?1`,
    )
    .bind(id, now, deciderId)
    .run();
}

// Board edit of every applicant-supplied field plus the Discord link and
// the board's note. The same uniqueness rules as on application apply,
// minus the row itself.
export async function updateRegisterEntry(
  db: D1Database,
  id: number,
  input: ApplicationInput,
  extra: { discord_id: string | null; board_note: string | null; member_type: MemberType },
  now: number,
): Promise<void> {
  const entry = await getRegisterEntry(db, id);
  if (!entry) throw new RuleError('missing', 'No register entry with that id.');
  const clash = await db
    .prepare(
      `SELECT id FROM register
       WHERE id != ?1 AND (email = ?2 COLLATE NOCASE OR (?3 IS NOT NULL AND discord_id = ?3))
       LIMIT 1`,
    )
    .bind(id, input.email, extra.discord_id)
    .first();
  if (clash) throw new RuleError('duplicate', 'Another entry already has that email or Discord account.');
  await db
    .prepare(
      `UPDATE register SET full_name = ?2, domicile = ?3, email = ?4, student_status = ?5,
         union_member = ?6, telegram = ?7, discord_name = ?8, discord_id = ?9, games = ?10,
         wants_active = ?11, message = ?12, board_note = ?13, updated_at = ?14, member_type = ?15,
         search_key = ?16
       WHERE id = ?1`,
    )
    .bind(
      id,
      input.full_name,
      input.domicile,
      input.email,
      input.student_status,
      input.union_member,
      input.telegram,
      input.discord_name,
      extra.discord_id,
      input.games,
      input.wants_active ? 1 : 0,
      input.message,
      extra.board_note,
      now,
      extra.member_type,
      searchKey([input.full_name, input.email, input.discord_name, input.telegram]),
    )
    .run();
}

// An entry the board creates by hand: an honorary member invited by the
// general meeting, a supporting member that is a company, an application
// handed over on paper. Consent is the board's own act, recorded as such.
export async function createBoardEntry(
  db: D1Database,
  input: ApplicationInput,
  extra: {
    member_type: MemberType;
    status: 'member' | 'pending';
    discord_id: string | null;
    board_note: string | null;
  },
  createdBy: string,
  now: number,
): Promise<number> {
  const clash = await db
    .prepare(
      `SELECT id FROM register
       WHERE email = ?1 COLLATE NOCASE OR (?2 IS NOT NULL AND discord_id = ?2)
       LIMIT 1`,
    )
    .bind(input.email, extra.discord_id)
    .first();
  if (clash) throw new RuleError('duplicate', 'This email or Discord account is already in the register.');
  const decided = extra.status === 'member';
  const result = await db
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member,
         member_type, telegram, discord_name, discord_id, games, wants_active, message, board_note,
         status, source, applied_at, consented_at, decided_at, decided_by, updated_at, search_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'board', ?15, ?15, ?16, ?17, ?15, ?18)
       RETURNING id`,
    )
    .bind(
      input.full_name,
      input.domicile,
      input.email,
      input.student_status,
      input.union_member,
      extra.member_type,
      input.telegram,
      input.discord_name,
      extra.discord_id,
      input.games,
      input.wants_active ? 1 : 0,
      input.message,
      extra.board_note,
      extra.status,
      now,
      decided ? now : null,
      decided ? createdBy : null,
      searchKey([input.full_name, input.email, input.discord_name, input.telegram]),
    )
    .first<{ id: number }>();
  return result!.id;
}

// Entries that look like the same person: same surname or same email
// local part, accent-insensitively. A hint on pending applications, not a
// rule; the board decides.
export async function findSimilarEntries(
  db: D1Database,
  entry: { id: number; full_name: string; email: string },
): Promise<RegisterRow[]> {
  const escape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const nameTokens = searchKey([entry.full_name]).split(' ').filter((t) => t.length >= 3);
  const surname = nameTokens.length > 1 ? nameTokens[nameTokens.length - 1] : null;
  const local = searchKey([entry.email.split('@')[0] ?? '']);
  const patterns: string[] = [];
  if (surname) patterns.push(`%${escape(surname)}%`);
  if (local.length >= 4) patterns.push(`%${escape(local)}%`);
  if (patterns.length === 0) return [];
  const clauses = patterns.map((_, i) => `search_key LIKE ?${i + 2} ESCAPE '\\'`).join(' OR ');
  const { results } = await db
    .prepare(`SELECT * FROM register WHERE id != ?1 AND (${clauses}) ORDER BY full_name COLLATE NOCASE LIMIT 5`)
    .bind(entry.id, ...patterns)
    .all<RegisterDbRow>();
  return results.map(fromDb);
}

export interface RegisterStats {
  actives: number;
  membersByType: Record<MemberType, number>;
  membersBySchool: Record<ApplicationInput['student_status'], number>;
  joinedByYear: { year: string; n: number }[];
}

// Numbers for the annual report, current members only. Years are UTC:
// a membership decided in the last two hours of New Year's Eve lands in
// the wrong year, which nobody will mind.
export async function registerStats(db: D1Database): Promise<RegisterStats> {
  const [actives, byType, bySchool, byYear] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM register WHERE status = 'member' AND is_active = 1")
      .first<{ n: number }>(),
    db
      .prepare("SELECT member_type AS k, COUNT(*) AS n FROM register WHERE status = 'member' GROUP BY 1")
      .all<{ k: MemberType; n: number }>(),
    db
      .prepare("SELECT student_status AS k, COUNT(*) AS n FROM register WHERE status = 'member' GROUP BY 1")
      .all<{ k: ApplicationInput['student_status']; n: number }>(),
    db
      .prepare(
        `SELECT strftime('%Y', coalesce(decided_at, applied_at), 'unixepoch') AS year, COUNT(*) AS n
         FROM register WHERE status = 'member' GROUP BY 1 ORDER BY 1`,
      )
      .all<{ year: string; n: number }>(),
  ]);
  const membersByType: Record<MemberType, number> = { full: 0, external: 0, supporting: 0, honorary: 0 };
  for (const row of byType.results) membersByType[row.k] = row.n;
  const membersBySchool: RegisterStats['membersBySchool'] = { LUT: 0, LAB: 0, alumni: 0, other: 0 };
  for (const row of bySchool.results) membersBySchool[row.k] = row.n;
  return { actives: actives?.n ?? 0, membersByType, membersBySchool, joinedByYear: byYear.results };
}

export const HOUSEKEEPING = {
  pendingAfterDays: 60,
  formerAfterDays: 730,
};

// What the register should probably not still hold: applications nobody
// decided in two months, former members two years on. Listed for the
// board with an erase button; nothing is deleted on its own.
export async function listHousekeeping(db: D1Database, now: number): Promise<RegisterRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM register
       WHERE (status = 'pending' AND applied_at < ?1) OR (status = 'former' AND updated_at < ?2)
       ORDER BY status, applied_at`,
    )
    .bind(now - HOUSEKEEPING.pendingAfterDays * 86400, now - HOUSEKEEPING.formerAfterDays * 86400)
    .all<RegisterDbRow>();
  return results.map(fromDb);
}

// member <-> former. A pending application goes through decideApplication.
export async function setRegisterStatus(
  db: D1Database,
  id: number,
  status: 'member' | 'former',
  now: number,
): Promise<void> {
  const entry = await getRegisterEntry(db, id);
  if (!entry || entry.status === 'pending') {
    throw new RuleError('missing', 'No decided register entry with that id.');
  }
  await db
    .prepare(
      status === 'former'
        ? 'UPDATE register SET status = ?2, updated_at = ?3, is_active = 0, wants_active = 0 WHERE id = ?1'
        : 'UPDATE register SET status = ?2, updated_at = ?3 WHERE id = ?1',
    )
    .bind(id, status, now)
    .run();
}

// --- actives -------------------------------------------------------------------

// Members who asked to be an active and are not one yet.
export async function listActiveRequests(db: D1Database): Promise<RegisterRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM register WHERE status = 'member' AND wants_active = 1 AND is_active = 0
       ORDER BY updated_at ASC`,
    )
    .all<RegisterDbRow>();
  return results.map(fromDb);
}

// The board's decision. Approve records when and by whom; decline or
// revoke clears both the approval and the request, so the person can ask
// again later and it shows up as new.
export async function setActive(
  db: D1Database,
  id: number,
  active: boolean,
  by: string,
  now: number,
): Promise<RegisterRow> {
  const entry = await getRegisterEntry(db, id);
  if (!entry || entry.status !== 'member') throw new RuleError('missing', 'No member with that id.');
  if (active) {
    await db
      .prepare(
        `UPDATE register SET is_active = 1, wants_active = 1, active_since = ?2, active_by = ?3, updated_at = ?2
         WHERE id = ?1`,
      )
      .bind(id, now, by)
      .run();
    return { ...entry, is_active: true, wants_active: true, active_since: now, active_by: by, updated_at: now };
  }
  await db
    .prepare(
      `UPDATE register SET is_active = 0, wants_active = 0, active_since = NULL, active_by = NULL, updated_at = ?2
       WHERE id = ?1`,
    )
    .bind(id, now)
    .run();
  return { ...entry, is_active: false, wants_active: false, active_since: null, active_by: null, updated_at: now };
}

// --- linking an existing entry to a Discord account -------------------------

// A signed-in Discord user says "entry with this email is mine". Matched
// or not, the caller answers the same way (no enumeration); a match parks
// the request on the entry for the board. A new request from the same
// Discord account replaces its earlier one.
export async function requestDiscordLink(
  db: D1Database,
  email: string,
  discordId: string,
  discordName: string,
  now: number,
): Promise<'requested' | 'none'> {
  const linked = await db
    .prepare('SELECT id FROM register WHERE discord_id = ?1')
    .bind(discordId)
    .first();
  if (linked) return 'none';
  const entry = await db
    .prepare('SELECT id FROM register WHERE email = ?1 COLLATE NOCASE AND discord_id IS NULL')
    .bind(email.trim().toLowerCase())
    .first<{ id: number }>();
  await db
    .prepare(
      `UPDATE register SET link_discord_id = NULL, link_discord_name = NULL, link_requested_at = NULL
       WHERE link_discord_id = ?1`,
    )
    .bind(discordId)
    .run();
  if (!entry) return 'none';
  await db
    .prepare(
      `UPDATE register SET link_discord_id = ?2, link_discord_name = ?3, link_requested_at = ?4, updated_at = ?4
       WHERE id = ?1`,
    )
    .bind(entry.id, discordId, discordName, now)
    .run();
  return 'requested';
}

export async function getPendingLinkByDiscord(
  db: D1Database,
  discordId: string,
): Promise<RegisterRow | null> {
  const row = await db
    .prepare('SELECT * FROM register WHERE link_discord_id = ?1')
    .bind(discordId)
    .first<RegisterDbRow>();
  return row ? fromDb(row) : null;
}

export async function listLinkRequests(db: D1Database): Promise<RegisterRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM register WHERE link_discord_id IS NOT NULL ORDER BY link_requested_at ASC')
    .all<RegisterDbRow>();
  return results.map(fromDb);
}

// Confirm makes the requesting account the entry's linked account (and
// records its handle as the Discord name); dismiss just clears the request.
export async function resolveLinkRequest(
  db: D1Database,
  id: number,
  decision: 'confirm' | 'dismiss',
  now: number,
): Promise<void> {
  const entry = await getRegisterEntry(db, id);
  if (!entry || entry.link_discord_id === null) {
    throw new RuleError('missing', 'No pending link request on that entry.');
  }
  if (decision === 'confirm') {
    const clash = await db
      .prepare('SELECT id FROM register WHERE discord_id = ?1 AND id != ?2')
      .bind(entry.link_discord_id, id)
      .first();
    if (clash) throw new RuleError('duplicate', 'That Discord account is already linked to another entry.');
    await db
      .prepare(
        `UPDATE register SET discord_id = link_discord_id, discord_name = link_discord_name,
           link_discord_id = NULL, link_discord_name = NULL, link_requested_at = NULL, updated_at = ?2,
           search_key = ?3
         WHERE id = ?1`,
      )
      .bind(id, now, searchKey([entry.full_name, entry.email, entry.link_discord_name, entry.telegram]))
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE register SET link_discord_id = NULL, link_discord_name = NULL, link_requested_at = NULL,
         updated_at = ?2
       WHERE id = ?1`,
    )
    .bind(id, now)
    .run();
}

// A linked member signed in again: their current handle replaces the one
// stored on the entry, so the register shows the name they go by now.
export async function refreshLinkedDiscordName(
  db: D1Database,
  discordId: string,
  handle: string,
  now: number,
): Promise<void> {
  const entry = await getRegisterByDiscord(db, discordId);
  if (!entry || entry.discord_name === handle) return;
  await db
    .prepare('UPDATE register SET discord_name = ?2, updated_at = ?3, search_key = ?4 WHERE id = ?1')
    .bind(entry.id, handle, now, searchKey([entry.full_name, entry.email, handle, entry.telegram]))
    .run();
}

// --- self-service ------------------------------------------------------------

// What a linked member may change about themselves without the board:
// asking to be an active (or leaving the actives, which also drops the
// board's approval) and the Telegram handle. Returns the entry, or null
// when this Discord account is not linked to one.
export async function setOwnActive(
  db: D1Database,
  discordId: string,
  wantsActive: boolean,
  telegram: string | null,
  now: number,
): Promise<RegisterRow | null> {
  const entry = await getRegisterByDiscord(db, discordId);
  if (!entry) return null;
  const isActive = wantsActive && entry.is_active;
  await db
    .prepare(
      `UPDATE register SET wants_active = ?2, is_active = ?3,
         active_since = CASE WHEN ?3 = 1 THEN active_since ELSE NULL END,
         active_by = CASE WHEN ?3 = 1 THEN active_by ELSE NULL END,
         telegram = ?4, updated_at = ?5, search_key = ?6
       WHERE id = ?1`,
    )
    .bind(
      entry.id,
      wantsActive ? 1 : 0,
      isActive ? 1 : 0,
      telegram,
      now,
      searchKey([entry.full_name, entry.email, entry.discord_name, telegram]),
    )
    .run();
  return {
    ...entry,
    wants_active: wantsActive,
    is_active: isActive,
    active_since: isActive ? entry.active_since : null,
    active_by: isActive ? entry.active_by : null,
    telegram,
    updated_at: now,
  };
}

// Everyone with a linked Discord account: what the role sync works from.
export async function listLinkedEntries(db: D1Database): Promise<RegisterRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM register WHERE discord_id IS NOT NULL')
    .all<RegisterDbRow>();
  return results.map(fromDb);
}

// The GDPR erasure path for the register: the row is gone, nothing is
// anonymized, because nothing references it.
export async function eraseRegisterEntry(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM register WHERE id = ?1').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// --- register access list ----------------------------------------------------
// Google Workspace accounts allowed to open the register, on top of the
// fixed ones in the REGISTER_ADMINS var. board.ts merges the two.

export interface RegisterAdminRow {
  email: string;
  added_by: string;
  added_at: number;
}

export async function listRegisterAdmins(db: D1Database): Promise<RegisterAdminRow[]> {
  const { results } = await db
    .prepare('SELECT email, added_by, added_at FROM register_admins ORDER BY added_at ASC')
    .all<RegisterAdminRow>();
  return results;
}

export async function addRegisterAdmin(
  db: D1Database,
  email: string,
  addedBy: string,
  now: number,
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO register_admins (email, added_by, added_at) VALUES (?1, ?2, ?3)')
    .bind(email.trim().toLowerCase(), addedBy, now)
    .run();
}

export async function removeRegisterAdmin(db: D1Database, email: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM register_admins WHERE email = ?1')
    .bind(email.trim().toLowerCase())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

