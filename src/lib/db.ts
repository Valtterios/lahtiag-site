// All D1 access, one exported function per operation (spec, Repository
// layout): a web form, a slash command and a future external bot share this
// one copy of the validation. Routes and command handlers never contain SQL.

import type { D1Database } from '@cloudflare/workers-types';
import type { ApplicationInput, MemberType, RegisterStatus } from './register';
import { deriveMemberType, searchKey } from './register';
import { newTicketCode } from './qr';
import { QUESTION_LIMITS, questionOptions, type EventQuestionRow, type QuestionKind } from './questions';

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
      | 'duplicate'
      | 'members_only'
      | 'reserved'
      | 'sales_closed'
      | 'sold_out'
      | 'has_ticket'
      | 'not_paid'
      | 'used'
      | 'payments_off'
      | 'needs_ticket'
      | 'answers',
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
  members_only: number; // 1 = signups and tickets need a linked, current member
  member_slots: number | null; // seats within capacity only members may take
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
    members_only?: boolean;
    member_slots?: number | null;
    created_by: string;
  },
  now: number,
): Promise<number> {
  if (!input.title.trim()) throw new RuleError('bad_input', 'An event needs a title.');
  checkEventText(input);
  if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    throw new RuleError('bad_input', 'Capacity must be a positive whole number.');
  }
  const memberSlots = checkMemberSlots(input.member_slots ?? null, input.capacity);
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
      `INSERT INTO events (title, description, starts_at, ends_at, capacity, team_size, organizers, link_url, created_by, created_at, members_only, member_slots)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id`,
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
      input.members_only ? 1 : 0,
      memberSlots,
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
    members_only?: boolean;
    member_slots?: number | null;
  },
): Promise<EventWithCounts> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  const memberSlots = checkMemberSlots(input.member_slots ?? null, input.capacity);
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
      `UPDATE events SET title = ?2, description = ?3, starts_at = ?4, ends_at = ?5, capacity = ?6, organizers = ?7, link_url = ?8,
         members_only = ?9, member_slots = ?10
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
      input.members_only ? 1 : 0,
      memberSlots,
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
  await db.prepare('DELETE FROM signup_answers WHERE event_id = ?1').bind(id).run();
  await db.prepare('DELETE FROM event_questions WHERE event_id = ?1').bind(id).run();
  await db.prepare('DELETE FROM door_payments WHERE ticket_id IN (SELECT id FROM tickets WHERE event_id = ?1)').bind(id).run();
  await db.prepare('DELETE FROM tickets WHERE event_id = ?1').bind(id).run();
  await db.prepare('DELETE FROM ticket_types WHERE event_id = ?1').bind(id).run();
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
  await requireEligible(db, event, discordId, status === 'yes');
  await requireTicketIfTicketed(db, eventId, discordId);
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
  // A paid ticket is the signup; leaving means a refund, from the board.
  if (await isTicketed(db, eventId)) throw new RuleError('needs_ticket', 'Ticket holders leave through a refund.');
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
  await requireEligible(db, event, discordId, false);
  await requireTicketIfTicketed(db, eventId, discordId);
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
  await requireEligible(db, event, discordId, false);
  await requireTicketIfTicketed(db, eventId, discordId);
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
  entry: { id: number; full_name: string; email: string; discord_name?: string | null },
): Promise<RegisterRow[]> {
  const escape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const nameTokens = searchKey([entry.full_name]).split(' ').filter((t) => t.length >= 3);
  const surname = nameTokens.length > 1 ? nameTokens[nameTokens.length - 1] : null;
  const local = searchKey([entry.email.split('@')[0] ?? '']);
  const handle = searchKey([entry.discord_name ?? '']).replace(/^@/, '');
  const patterns: string[] = [];
  if (surname) patterns.push(`%${escape(surname)}%`);
  if (local.length >= 4) patterns.push(`%${escape(local)}%`);
  if (handle.length >= 3) patterns.push(`%${escape(handle)}%`);
  if (patterns.length === 0) return [];
  const clauses = patterns.map((_, i) => `search_key LIKE ?${i + 2} ESCAPE '\\'`).join(' OR ');
  const { results } = await db
    .prepare(`SELECT * FROM register WHERE id != ?1 AND (${clauses}) ORDER BY full_name COLLATE NOCASE LIMIT 5`)
    .bind(entry.id, ...patterns)
    .all<RegisterDbRow>();
  return results.map(fromDb);
}

// A pending application that is really an existing member applying again:
// keep the existing entry, carry over what the application added (their
// latest domicile, school, union, handles, games, message, the actives
// request, and the Discord link if they applied signed in), delete the
// duplicate. Name, email, class, status and dates stay as they were.
export async function mergeApplicationInto(
  db: D1Database,
  pendingId: number,
  targetId: number,
  now: number,
): Promise<RegisterRow> {
  const pending = await getRegisterEntry(db, pendingId);
  const target = await getRegisterEntry(db, targetId);
  if (!pending || pending.status !== 'pending' || !target || target.id === pending.id) {
    throw new RuleError('missing', 'Merging needs a pending application and a different existing entry.');
  }
  if (pending.discord_id && target.discord_id && target.discord_id !== pending.discord_id) {
    throw new RuleError('duplicate', 'Both entries are linked to different Discord accounts.');
  }
  const discordId = target.discord_id ?? pending.discord_id;
  const discordName = pending.discord_id ? pending.discord_name : (target.discord_name ?? pending.discord_name);
  const telegram = pending.telegram ?? target.telegram;
  const games = pending.games ?? target.games;
  const message = pending.message ?? target.message;
  const wantsActive = target.wants_active || pending.wants_active;
  // The duplicate goes first: its Discord id must be free before the
  // target can take it (unique index).
  await db.prepare('DELETE FROM register WHERE id = ?1').bind(pendingId).run();
  await db
    .prepare(
      `UPDATE register SET domicile = ?2, student_status = ?3, union_member = ?4, telegram = ?5,
         discord_name = ?6, discord_id = ?7, games = ?8, wants_active = ?9, message = ?10,
         link_discord_id = CASE WHEN link_discord_id = ?7 THEN NULL ELSE link_discord_id END,
         link_discord_name = CASE WHEN link_discord_id = ?7 THEN NULL ELSE link_discord_name END,
         link_requested_at = CASE WHEN link_discord_id = ?7 THEN NULL ELSE link_requested_at END,
         updated_at = ?11, search_key = ?12
       WHERE id = ?1`,
    )
    .bind(
      targetId,
      pending.domicile,
      pending.student_status,
      pending.union_member,
      telegram,
      discordName,
      discordId,
      games,
      wantsActive ? 1 : 0,
      message,
      now,
      searchKey([target.full_name, target.email, discordName, telegram]),
    )
    .run();
  return (await getRegisterEntry(db, targetId))!;
}

// A linked member editing their own details on /membership: everything
// they supplied on the application, with the same validation and the same
// email uniqueness; never status, class, or the Discord link.
export async function updateOwnEntry(
  db: D1Database,
  discordId: string,
  input: ApplicationInput,
  now: number,
): Promise<RegisterRow | null> {
  const entry = await getRegisterByDiscord(db, discordId);
  if (!entry) return null;
  const clash = await db
    .prepare('SELECT id FROM register WHERE id != ?1 AND email = ?2 COLLATE NOCASE LIMIT 1')
    .bind(entry.id, input.email)
    .first();
  if (clash) throw new RuleError('duplicate', 'Another entry already has that email.');
  const isActive = input.wants_active && entry.is_active;
  await db
    .prepare(
      `UPDATE register SET full_name = ?2, domicile = ?3, email = ?4, student_status = ?5,
         union_member = ?6, telegram = ?7, games = ?8, wants_active = ?9, is_active = ?10,
         active_since = CASE WHEN ?10 = 1 THEN active_since ELSE NULL END,
         active_by = CASE WHEN ?10 = 1 THEN active_by ELSE NULL END,
         message = ?11, updated_at = ?12, search_key = ?13
       WHERE id = ?1`,
    )
    .bind(
      entry.id,
      input.full_name,
      input.domicile,
      input.email,
      input.student_status,
      input.union_member,
      input.telegram,
      input.games,
      input.wants_active ? 1 : 0,
      isActive ? 1 : 0,
      input.message,
      now,
      searchKey([input.full_name, input.email, entry.discord_name, input.telegram]),
    )
    .run();
  return (await getRegisterEntry(db, entry.id))!;
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

// --- settings ------------------------------------------------------------------
// Board-editable configuration (migration 0010). Keys live here so a typo
// cannot invent one.

export type SettingKey = 'member_role_id' | 'actives_role_id';

export async function getSettings(db: D1Database): Promise<Partial<Record<SettingKey, string>>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: SettingKey; value: string }>();
  const out: Partial<Record<SettingKey, string>> = {};
  for (const row of results) out[row.key] = row.value;
  return out;
}

export async function setSetting(
  db: D1Database,
  key: SettingKey,
  value: string,
  by: string,
  now: number,
): Promise<void> {
  if (value === '') {
    await db.prepare('DELETE FROM settings WHERE key = ?1').bind(key).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET value = ?2, updated_by = ?3, updated_at = ?4`,
    )
    .bind(key, value, by, now)
    .run();
}

// --- membership gate on events ---------------------------------------------------

function checkMemberSlots(slots: number | null, capacity: number | null): number | null {
  if (slots === null) return null;
  if (!Number.isInteger(slots) || slots < 1) throw new RuleError('bad_input', 'Reserved seats must be a positive whole number.');
  if (capacity === null) throw new RuleError('bad_input', 'Reserved seats need a capacity.');
  if (slots > capacity) throw new RuleError('bad_input', 'Reserved seats cannot exceed the capacity.');
  return slots;
}

// A current member of the association with this Discord account linked.
export async function isCurrentMember(db: D1Database, discordId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM register WHERE discord_id = ?1 AND status = 'member'")
    .bind(discordId)
    .first();
  return row !== null;
}

export interface SeatAccess {
  allowed: boolean;
  reason: 'members_only' | 'reserved' | null;
  member: boolean;
  // Seats a non-member could still take (capacity minus reserved minus
  // non-member yes signups), or null when the event has no such limit.
  openSeatsLeft: number | null;
}

// Whether this person may sign up (or buy) here. Members-only events
// need a linked current member; reserved seats keep `member_slots` of
// the capacity for members, so non-members stop at capacity - slots.
// The person's own existing yes never counts against them.
export async function signupAccess(
  db: D1Database,
  event: Pick<EventRow, 'id' | 'members_only' | 'member_slots' | 'capacity' | 'team_size'>,
  discordId: string | null,
  wantsSeat: boolean,
): Promise<SeatAccess> {
  const member = discordId ? await isCurrentMember(db, discordId) : false;
  if (event.members_only === 1 && !member) {
    return { allowed: false, reason: 'members_only', member, openSeatsLeft: null };
  }
  const limited = event.member_slots !== null && event.capacity !== null && event.team_size === null;
  if (!limited) return { allowed: true, reason: null, member, openSeatsLeft: null };
  const nonMembers = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM signups s
       WHERE s.event_id = ?1 AND s.status = 'yes' AND s.discord_id != ?2
         AND NOT EXISTS (SELECT 1 FROM register r WHERE r.discord_id = s.discord_id AND r.status = 'member')`,
    )
    .bind(event.id, discordId ?? '')
    .first<{ n: number }>();
  const openSeatsLeft = Math.max(0, event.capacity! - event.member_slots! - (nonMembers?.n ?? 0));
  if (wantsSeat && !member && openSeatsLeft === 0) {
    return { allowed: false, reason: 'reserved', member, openSeatsLeft };
  }
  return { allowed: true, reason: null, member, openSeatsLeft };
}

async function requireEligible(
  db: D1Database,
  event: Pick<EventRow, 'id' | 'members_only' | 'member_slots' | 'capacity' | 'team_size'>,
  discordId: string,
  wantsSeat: boolean,
): Promise<SeatAccess> {
  const access = await signupAccess(db, event, discordId, wantsSeat);
  if (!access.allowed) {
    throw new RuleError(
      access.reason!,
      access.reason === 'members_only'
        ? 'This event is for members.'
        : 'The remaining seats are reserved for members.',
    );
  }
  return access;
}

// --- tickets -------------------------------------------------------------------------

export interface TicketTypeRow {
  id: number;
  event_id: number;
  name: string;
  price_cents: number;
  member_price_cents: number | null;
  members_only: number;
  quantity: number | null;
  sales_close_at: number | null;
  sort: number;
  active: number;
}

export interface TicketTypeWithSales extends TicketTypeRow {
  sold: number; // paid + still-pending
  revenue_cents: number; // paid only
}

export interface TicketRow {
  id: number;
  event_id: number;
  ticket_type_id: number;
  discord_id: string | null;
  holder_name: string;
  code: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'refunded' | 'void';
  source: 'online' | 'door' | 'comp';
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  created_at: number;
  paid_at: number | null;
  checked_in_at: number | null;
  checked_in_by: string | null;
}

export interface TicketWithType extends TicketRow {
  type_name: string;
  event_title: string;
  starts_at: number;
}

// Pending tickets hold a seat only for as long as the Checkout session
// lives; after that they no longer count and the webhook marks them void.
export const PENDING_TICKET_SECONDS = 35 * 60;

function checkTicketTypeInput(input: {
  name: string;
  price_cents: number;
  member_price_cents: number | null;
  quantity: number | null;
}): void {
  const name = input.name.trim();
  if (!name || name.length > 60) throw new RuleError('bad_input', 'A ticket type name is 1 to 60 characters.');
  if (!Number.isInteger(input.price_cents) || input.price_cents < 0 || input.price_cents > 100000) {
    throw new RuleError('bad_input', 'The price must be between 0 and 1000 euros.');
  }
  if (input.member_price_cents !== null && (!Number.isInteger(input.member_price_cents) || input.member_price_cents < 0 || input.member_price_cents > input.price_cents)) {
    throw new RuleError('bad_input', 'The member price must be between 0 and the normal price.');
  }
  if (input.quantity !== null && (!Number.isInteger(input.quantity) || input.quantity < 1)) {
    throw new RuleError('bad_input', 'Quantity must be a positive whole number.');
  }
}

export async function listTicketTypes(db: D1Database, eventId: number): Promise<TicketTypeWithSales[]> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(*) FROM tickets k WHERE k.ticket_type_id = t.id
            AND (k.status = 'paid' OR (k.status = 'pending' AND k.created_at > ?2))) AS sold,
         (SELECT COALESCE(SUM(k.amount_cents), 0) FROM tickets k WHERE k.ticket_type_id = t.id AND k.status = 'paid') AS revenue_cents
       FROM ticket_types t WHERE t.event_id = ?1 ORDER BY t.sort, t.id`,
    )
    .bind(eventId, now - PENDING_TICKET_SECONDS)
    .all<TicketTypeWithSales>();
  return results;
}

export async function getTicketType(db: D1Database, id: number): Promise<TicketTypeWithSales | null> {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(*) FROM tickets k WHERE k.ticket_type_id = t.id
            AND (k.status = 'paid' OR (k.status = 'pending' AND k.created_at > ?2))) AS sold,
         (SELECT COALESCE(SUM(k.amount_cents), 0) FROM tickets k WHERE k.ticket_type_id = t.id AND k.status = 'paid') AS revenue_cents
       FROM ticket_types t WHERE t.id = ?1`,
    )
    .bind(id, now - PENDING_TICKET_SECONDS)
    .first<TicketTypeWithSales>();
}

export async function createTicketType(
  db: D1Database,
  eventId: number,
  input: {
    name: string;
    price_cents: number;
    member_price_cents: number | null;
    members_only: boolean;
    quantity: number | null;
    sales_close_at: number | null;
  },
): Promise<number> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  checkTicketTypeInput(input);
  const last = await db
    .prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM ticket_types WHERE event_id = ?1')
    .bind(eventId)
    .first<{ s: number }>();
  const row = await db
    .prepare(
      `INSERT INTO ticket_types (event_id, name, price_cents, member_price_cents, members_only, quantity, sales_close_at, sort)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
    )
    .bind(eventId, input.name.trim(), input.price_cents, input.member_price_cents, input.members_only ? 1 : 0, input.quantity, input.sales_close_at, (last?.s ?? 0) + 1)
    .first<{ id: number }>();
  return row!.id;
}

export async function updateTicketType(
  db: D1Database,
  id: number,
  input: {
    name: string;
    price_cents: number;
    member_price_cents: number | null;
    members_only: boolean;
    quantity: number | null;
    sales_close_at: number | null;
    active: boolean;
  },
): Promise<void> {
  const type = await getTicketType(db, id);
  if (!type) throw new RuleError('missing', 'No such ticket type.');
  checkTicketTypeInput(input);
  await db
    .prepare(
      `UPDATE ticket_types SET name = ?2, price_cents = ?3, member_price_cents = ?4, members_only = ?5,
         quantity = ?6, sales_close_at = ?7, active = ?8 WHERE id = ?1`,
    )
    .bind(id, input.name.trim(), input.price_cents, input.member_price_cents, input.members_only ? 1 : 0, input.quantity, input.sales_close_at, input.active ? 1 : 0)
    .run();
}

// A type with tickets is deactivated instead of deleted: the tickets
// need it to say what they are.
export async function deleteTicketType(db: D1Database, id: number): Promise<'deleted' | 'deactivated'> {
  const used = await db.prepare('SELECT 1 AS ok FROM tickets WHERE ticket_type_id = ?1 LIMIT 1').bind(id).first();
  if (used) {
    await db.prepare('UPDATE ticket_types SET active = 0 WHERE id = ?1').bind(id).run();
    return 'deactivated';
  }
  await db.prepare('DELETE FROM ticket_types WHERE id = ?1').bind(id).run();
  return 'deleted';
}

// What this person would pay for this type, or why they cannot buy it.
export async function ticketOffer(
  db: D1Database,
  event: EventRow,
  type: TicketTypeWithSales,
  discordId: string | null,
  now: number,
): Promise<{ ok: true; amount_cents: number; member: boolean } | { ok: false; reason: RuleError['code'] }> {
  if (event.cancelled_at !== null) return { ok: false, reason: 'cancelled' };
  if (type.active !== 1) return { ok: false, reason: 'sales_closed' };
  const closes = type.sales_close_at ?? event.starts_at;
  if (now >= closes) return { ok: false, reason: 'sales_closed' };
  if (type.quantity !== null && type.sold >= type.quantity) return { ok: false, reason: 'sold_out' };
  const access = await signupAccess(db, event, discordId, true);
  if (type.members_only === 1 && !access.member) return { ok: false, reason: 'members_only' };
  if (!access.allowed) return { ok: false, reason: access.reason! };
  if (event.capacity !== null && event.team_size === null) {
    const live = await countLiveTickets(db, event.id, now);
    if (live >= event.capacity) return { ok: false, reason: 'full' };
  }
  if (discordId) {
    const mine = await db
      .prepare("SELECT 1 AS ok FROM tickets WHERE event_id = ?1 AND discord_id = ?2 AND status IN ('pending','paid')")
      .bind(event.id, discordId)
      .first();
    if (mine) return { ok: false, reason: 'has_ticket' };
  }
  const amount = access.member && type.member_price_cents !== null ? type.member_price_cents : type.price_cents;
  return { ok: true, amount_cents: amount, member: access.member };
}

async function countLiveTickets(db: D1Database, eventId: number, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets WHERE event_id = ?1
         AND (status = 'paid' OR (status = 'pending' AND created_at > ?2))`,
    )
    .bind(eventId, now - PENDING_TICKET_SECONDS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// A ticket row. Paid tickets for a linked holder also mean a 'yes' signup,
// placed directly: the seat was checked when the ticket was offered.
export async function createTicket(
  db: D1Database,
  input: {
    event_id: number;
    ticket_type_id: number;
    discord_id: string | null;
    holder_name: string;
    amount_cents: number;
    status: 'pending' | 'paid';
    source: 'online' | 'door' | 'comp';
    stripe_session_id?: string | null;
    stripe_payment_intent?: string | null;
  },
  now: number,
): Promise<TicketRow> {
  const holder = input.holder_name.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Ticket holder';
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newTicketCode();
    try {
      const row = await db
        .prepare(
          `INSERT INTO tickets (event_id, ticket_type_id, discord_id, holder_name, code, amount_cents, status, source,
             stripe_session_id, stripe_payment_intent, created_at, paid_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING *`,
        )
        .bind(
          input.event_id,
          input.ticket_type_id,
          input.discord_id,
          holder,
          code,
          input.amount_cents,
          input.status,
          input.source,
          input.stripe_session_id ?? null,
          input.stripe_payment_intent ?? null,
          now,
          input.status === 'paid' ? now : null,
        )
        .first<TicketRow>();
      if (input.status === 'paid' && input.discord_id) await ensureYesSignup(db, input.event_id, input.discord_id, now);
      return row!;
    } catch (error) {
      // A code collision retries; a second live ticket for the same account
      // does not (D1 names the columns, not the index).
      const message = String(error);
      if (message.includes('UNIQUE') && !message.includes('tickets.code')) {
        throw new RuleError('has_ticket', 'This account already has a ticket.');
      }
      if (attempt === 4) throw error;
    }
  }
  throw new Error('unreachable');
}

async function ensureYesSignup(db: D1Database, eventId: number, discordId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id)
       VALUES (?1, ?2, 'yes', ?3, NULL)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = 'yes'`,
    )
    .bind(eventId, discordId, now)
    .run();
}

const TICKET_SELECT = `SELECT k.*, t.name AS type_name, e.title AS event_title, e.starts_at
  FROM tickets k JOIN ticket_types t ON t.id = k.ticket_type_id JOIN events e ON e.id = k.event_id`;

export async function getTicketByCode(db: D1Database, code: string): Promise<TicketWithType | null> {
  return db.prepare(`${TICKET_SELECT} WHERE k.code = ?1`).bind(code).first<TicketWithType>();
}

export async function getTicketBySession(db: D1Database, sessionId: string): Promise<TicketRow | null> {
  return db.prepare('SELECT * FROM tickets WHERE stripe_session_id = ?1').bind(sessionId).first<TicketRow>();
}

export async function getTicketByPaymentIntent(db: D1Database, paymentIntent: string): Promise<TicketRow | null> {
  return db.prepare('SELECT * FROM tickets WHERE stripe_payment_intent = ?1').bind(paymentIntent).first<TicketRow>();
}

export async function listMyTickets(db: D1Database, discordId: string): Promise<TicketWithType[]> {
  const { results } = await db
    .prepare(`${TICKET_SELECT} WHERE k.discord_id = ?1 AND k.status IN ('paid','pending') ORDER BY e.starts_at DESC`)
    .bind(discordId)
    .all<TicketWithType>();
  return results;
}

export async function listEventTickets(db: D1Database, eventId: number): Promise<TicketWithType[]> {
  const { results } = await db
    .prepare(`${TICKET_SELECT} WHERE k.event_id = ?1 ORDER BY k.holder_name COLLATE NOCASE`)
    .bind(eventId)
    .all<TicketWithType>();
  return results;
}

// The webhook's "paid": idempotent, keeps the first paid_at, and adds the
// signup for a linked holder. The holder name may arrive with the payment
// (door sales by QR, typed on Stripe's page).
export async function markTicketPaid(
  db: D1Database,
  ticketId: number,
  paymentIntent: string | null,
  holderName: string | null,
  now: number,
): Promise<TicketRow | null> {
  const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ?1').bind(ticketId).first<TicketRow>();
  if (!ticket) return null;
  if (ticket.status === 'paid') return ticket;
  await db
    .prepare(
      `UPDATE tickets SET status = 'paid', paid_at = ?2, stripe_payment_intent = COALESCE(?3, stripe_payment_intent),
         holder_name = COALESCE(?4, holder_name) WHERE id = ?1`,
    )
    .bind(ticketId, now, paymentIntent, holderName)
    .run();
  if (ticket.discord_id) await ensureYesSignup(db, ticket.event_id, ticket.discord_id, now);
  if (paymentIntent) {
    await db.prepare('DELETE FROM door_payments WHERE stripe_payment_intent = ?1 AND ticket_id IS NULL').bind(paymentIntent).run();
  }
  return (await db.prepare('SELECT * FROM tickets WHERE id = ?1').bind(ticketId).first<TicketRow>())!;
}

export async function voidTicket(db: D1Database, ticketId: number): Promise<void> {
  await db.prepare("UPDATE tickets SET status = 'void' WHERE id = ?1 AND status = 'pending'").bind(ticketId).run();
}

// A refund (from Stripe's dashboard, reported by the webhook, or a comp
// ticket withdrawn by the board): the ticket is dead and the seat freed.
export async function refundTicket(db: D1Database, ticketId: number): Promise<TicketRow | null> {
  const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ?1').bind(ticketId).first<TicketRow>();
  if (!ticket || ticket.status === 'refunded') return ticket;
  await db.prepare("UPDATE tickets SET status = 'refunded' WHERE id = ?1").bind(ticketId).run();
  if (ticket.discord_id) {
    await db.prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2').bind(ticket.event_id, ticket.discord_id).run();
    await dropEmptyEventTeams(db, ticket.event_id);
  }
  return { ...ticket, status: 'refunded' };
}

// The door: a paid ticket, once. `by` is who scanned it (a Discord id or a
// Workspace email), for the record.
export async function checkInTicket(
  db: D1Database,
  code: string,
  by: string,
  now: number,
): Promise<TicketWithType> {
  const ticket = await getTicketByCode(db, code);
  if (!ticket) throw new RuleError('missing', 'No ticket with that code.');
  if (ticket.status !== 'paid') throw new RuleError('not_paid', 'This ticket is not paid.');
  if (ticket.checked_in_at !== null) throw new RuleError('used', 'This ticket was already used.');
  await db
    .prepare('UPDATE tickets SET checked_in_at = ?2, checked_in_by = ?3 WHERE id = ?1')
    .bind(ticket.id, now, by)
    .run();
  return { ...ticket, checked_in_at: now, checked_in_by: by };
}

export async function undoCheckIn(db: D1Database, ticketId: number): Promise<void> {
  await db.prepare('UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL WHERE id = ?1').bind(ticketId).run();
}

// Tap to Pay in the Stripe Dashboard app: a payment with no ticket behind
// it, kept until someone at the door attaches it to a person.
export async function recordDoorPayment(db: D1Database, paymentIntent: string, amountCents: number, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO door_payments (stripe_payment_intent, amount_cents, created_at) VALUES (?1, ?2, ?3)')
    .bind(paymentIntent, amountCents, now)
    .run();
}

export interface DoorPaymentRow {
  stripe_payment_intent: string;
  amount_cents: number;
  created_at: number;
  ticket_id: number | null;
}

export async function listUnattachedDoorPayments(db: D1Database, since: number): Promise<DoorPaymentRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM door_payments WHERE ticket_id IS NULL AND created_at >= ?1 ORDER BY created_at DESC')
    .bind(since)
    .all<DoorPaymentRow>();
  return results;
}

// A door payment becomes a paid door ticket for the named person.
export async function attachDoorPayment(
  db: D1Database,
  paymentIntent: string,
  eventId: number,
  ticketTypeId: number,
  holderName: string,
  now: number,
): Promise<TicketRow> {
  const payment = await db
    .prepare('SELECT * FROM door_payments WHERE stripe_payment_intent = ?1 AND ticket_id IS NULL')
    .bind(paymentIntent)
    .first<DoorPaymentRow>();
  if (!payment) throw new RuleError('missing', 'No unattached payment with that id.');
  const type = await getTicketType(db, ticketTypeId);
  if (!type || type.event_id !== eventId) throw new RuleError('missing', 'No such ticket type on this event.');
  const ticket = await createTicket(
    db,
    {
      event_id: eventId,
      ticket_type_id: ticketTypeId,
      discord_id: null,
      holder_name: holderName,
      amount_cents: payment.amount_cents,
      status: 'paid',
      source: 'door',
      stripe_payment_intent: paymentIntent,
    },
    now,
  );
  await db.prepare('UPDATE door_payments SET ticket_id = ?2 WHERE stripe_payment_intent = ?1').bind(paymentIntent, ticket.id).run();
  return ticket;
}

export interface SalesSummary {
  tickets: number;
  checked_in: number;
  revenue_cents: number;
  by_type: TicketTypeWithSales[];
}

export async function salesSummary(db: D1Database, eventId: number): Promise<SalesSummary> {
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS tickets, SUM(checked_in_at IS NOT NULL) AS checked_in, COALESCE(SUM(amount_cents), 0) AS revenue_cents
       FROM tickets WHERE event_id = ?1 AND status = 'paid'`,
    )
    .bind(eventId)
    .first<{ tickets: number; checked_in: number; revenue_cents: number }>();
  return {
    tickets: totals?.tickets ?? 0,
    checked_in: totals?.checked_in ?? 0,
    revenue_cents: totals?.revenue_cents ?? 0,
    by_type: await listTicketTypes(db, eventId),
  };
}

export async function getTicketForHolder(db: D1Database, eventId: number, discordId: string): Promise<TicketWithType | null> {
  return db
    .prepare(`${TICKET_SELECT} WHERE k.event_id = ?1 AND k.discord_id = ?2 AND k.status IN ('pending','paid') ORDER BY k.created_at DESC`)
    .bind(eventId, discordId)
    .first<TicketWithType>();
}

// --- ticketed events ---------------------------------------------------------------

// An event with at least one ticket type on sale takes people through
// tickets: the paid ticket is the signup, and team formation needs one.
export async function isTicketed(db: D1Database, eventId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM ticket_types WHERE event_id = ?1 AND active = 1 LIMIT 1')
    .bind(eventId)
    .first();
  return row !== null;
}

export async function hasPaidTicket(db: D1Database, eventId: number, discordId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM tickets WHERE event_id = ?1 AND discord_id = ?2 AND status = 'paid'")
    .bind(eventId, discordId)
    .first();
  return row !== null;
}

async function requireTicketIfTicketed(db: D1Database, eventId: number, discordId: string): Promise<void> {
  if (!(await isTicketed(db, eventId))) return;
  if (!(await hasPaidTicket(db, eventId, discordId))) {
    throw new RuleError('needs_ticket', 'This event needs a ticket first.');
  }
}

// --- event questions and answers ----------------------------------------------

export async function listEventQuestions(db: D1Database, eventId: number): Promise<EventQuestionRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM event_questions WHERE event_id = ?1 ORDER BY sort, id')
    .bind(eventId)
    .all<EventQuestionRow>();
  return results;
}

function checkQuestionInput(input: { label: string; kind: QuestionKind; options: string | null }): void {
  const label = input.label.trim();
  if (!label || label.length > QUESTION_LIMITS.label) throw new RuleError('bad_input', 'A question is 1 to 80 characters.');
  if (input.kind === 'choice' && questionOptions({ options: input.options }).length < 2) {
    throw new RuleError('bad_input', 'A choice question needs at least two options, one per line.');
  }
  if ((input.options ?? '').length > QUESTION_LIMITS.options) throw new RuleError('bad_input', 'Too many options.');
}

export async function createEventQuestion(
  db: D1Database,
  eventId: number,
  input: { label: string; kind: QuestionKind; options: string | null; required: boolean },
): Promise<number> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  checkQuestionInput(input);
  const count = await db
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort), 0) AS s FROM event_questions WHERE event_id = ?1')
    .bind(eventId)
    .first<{ n: number; s: number }>();
  if ((count?.n ?? 0) >= QUESTION_LIMITS.perEvent) throw new RuleError('bad_input', 'Eight questions is the limit.');
  const row = await db
    .prepare(
      `INSERT INTO event_questions (event_id, label, kind, options, required, sort)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
    )
    .bind(eventId, input.label.trim(), input.kind, input.kind === 'choice' ? input.options : null, input.required ? 1 : 0, (count?.s ?? 0) + 1)
    .first<{ id: number }>();
  return row!.id;
}

export async function updateEventQuestion(
  db: D1Database,
  id: number,
  input: { label: string; kind: QuestionKind; options: string | null; required: boolean },
): Promise<void> {
  checkQuestionInput(input);
  await db
    .prepare('UPDATE event_questions SET label = ?2, kind = ?3, options = ?4, required = ?5 WHERE id = ?1')
    .bind(id, input.label.trim(), input.kind, input.kind === 'choice' ? input.options : null, input.required ? 1 : 0)
    .run();
}

export async function deleteEventQuestion(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM signup_answers WHERE question_id = ?1').bind(id).run();
  await db.prepare('DELETE FROM event_questions WHERE id = ?1').bind(id).run();
}

export type AnswerOwner = { discordId: string } | { ticketId: number };

export async function saveAnswers(
  db: D1Database,
  eventId: number,
  owner: AnswerOwner,
  answers: Map<number, string>,
  now: number,
): Promise<void> {
  for (const [questionId, value] of answers) {
    if ('discordId' in owner) {
      await db
        .prepare(
          `INSERT INTO signup_answers (question_id, event_id, discord_id, ticket_id, value, updated_at)
           VALUES (?1, ?2, ?3, NULL, ?4, ?5)
           ON CONFLICT (question_id, discord_id) WHERE discord_id IS NOT NULL
           DO UPDATE SET value = ?4, updated_at = ?5`,
        )
        .bind(questionId, eventId, owner.discordId, value, now)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO signup_answers (question_id, event_id, discord_id, ticket_id, value, updated_at)
           VALUES (?1, ?2, NULL, ?3, ?4, ?5)
           ON CONFLICT (question_id, ticket_id) WHERE ticket_id IS NOT NULL
           DO UPDATE SET value = ?4, updated_at = ?5`,
        )
        .bind(questionId, eventId, owner.ticketId, value, now)
        .run();
    }
  }
}

export async function getAnswers(db: D1Database, eventId: number, owner: AnswerOwner): Promise<Map<number, string>> {
  const { results } =
    'discordId' in owner
      ? await db
          .prepare('SELECT question_id, value FROM signup_answers WHERE event_id = ?1 AND discord_id = ?2')
          .bind(eventId, owner.discordId)
          .all<{ question_id: number; value: string }>()
      : await db
          .prepare('SELECT question_id, value FROM signup_answers WHERE event_id = ?1 AND ticket_id = ?2')
          .bind(eventId, owner.ticketId)
          .all<{ question_id: number; value: string }>();
  return new Map(results.map((r) => [r.question_id, r.value]));
}

// Every answer on an event, keyed "u:<discord id>" or "t:<ticket id>",
// for rosters, the door and exports.
export async function listAllAnswers(db: D1Database, eventId: number): Promise<Map<string, Map<number, string>>> {
  const { results } = await db
    .prepare('SELECT question_id, discord_id, ticket_id, value FROM signup_answers WHERE event_id = ?1')
    .bind(eventId)
    .all<{ question_id: number; discord_id: string | null; ticket_id: number | null; value: string }>();
  const out = new Map<string, Map<number, string>>();
  for (const r of results) {
    const key = r.discord_id ? `u:${r.discord_id}` : `t:${r.ticket_id}`;
    if (!out.has(key)) out.set(key, new Map());
    out.get(key)!.set(r.question_id, r.value);
  }
  return out;
}

