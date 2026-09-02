// All D1 access, one exported function per operation (spec, Repository
// layout): a web form, a slash command and a future external bot share this
// one copy of the validation. Routes and command handlers never contain SQL.

import type { D1Database } from '@cloudflare/workers-types';

export class RuleError extends Error {
  constructor(
    public code: 'missing' | 'cancelled' | 'full' | 'started' | 'bad_input',
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
  capacity: number | null;
  team_id: number | null;
  created_by: string;
  created_at: number;
  cancelled_at: number | null;
  discord_message_id: string | null;
}

export interface EventWithCounts extends EventRow {
  yes_count: number;
  maybe_count: number;
}

export interface SignupRow {
  discord_id: string;
  status: 'yes' | 'maybe';
  created_at: number;
  username: string;
  avatar_hash: string | null;
}

export interface TeamRow {
  id: number;
  name: string;
  game: string;
  active: number;
}

export interface TeamMemberRow {
  team_id: number;
  discord_id: string;
  position: string | null;
  username: string;
  avatar_hash: string | null;
}

export interface AnnouncementRow {
  id: number;
  title: string;
  body_md: string;
  published_at: number;
  author_id: string;
  source: 'web' | 'discord';
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
    (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status = 'maybe') AS maybe_count
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
    team_id: number | null;
    created_by: string;
  },
  now: number,
): Promise<number> {
  if (!input.title.trim()) throw new RuleError('bad_input', 'An event needs a title.');
  if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    throw new RuleError('bad_input', 'Capacity must be a positive whole number.');
  }
  const row = await db
    .prepare(
      `INSERT INTO events (title, description, starts_at, capacity, team_id, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    )
    .bind(
      input.title.trim(),
      input.description,
      input.starts_at,
      input.capacity,
      input.team_id,
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
// own existing answer never counts you twice.
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
  if (status === 'yes' && event.capacity !== null) {
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
      `INSERT INTO signups (event_id, discord_id, status, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = ?3`,
    )
    .bind(eventId, discordId, status, now)
    .run();
}

export async function removeSignup(db: D1Database, eventId: number, discordId: string): Promise<void> {
  await db
    .prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .run();
}

export async function listSignups(db: D1Database, eventId: number): Promise<SignupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.discord_id, s.status, s.created_at, m.username, m.avatar_hash
       FROM signups s JOIN members m ON m.discord_id = s.discord_id
       WHERE s.event_id = ?1
       ORDER BY s.created_at ASC`,
    )
    .bind(eventId)
    .all<SignupRow>();
  return results;
}

export async function listTeams(db: D1Database): Promise<TeamRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM teams WHERE active = 1 ORDER BY game, name')
    .all<TeamRow>();
  return results;
}

export async function findTeamByName(db: D1Database, name: string): Promise<TeamRow | null> {
  return db
    .prepare('SELECT * FROM teams WHERE active = 1 AND name = ?1 COLLATE NOCASE')
    .bind(name.trim())
    .first<TeamRow>();
}

export async function getTeam(db: D1Database, id: number): Promise<TeamRow | null> {
  return db.prepare('SELECT * FROM teams WHERE id = ?1').bind(id).first<TeamRow>();
}

export async function createTeam(db: D1Database, name: string, game: string): Promise<number> {
  if (!name.trim() || !game.trim()) throw new RuleError('bad_input', 'A team needs a name and a game.');
  const row = await db
    .prepare('INSERT INTO teams (name, game) VALUES (?1, ?2) RETURNING id')
    .bind(name.trim(), game.trim())
    .first<{ id: number }>();
  return row!.id;
}

export async function listTeamMembers(db: D1Database): Promise<TeamMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.team_id, t.discord_id, t.position, m.username, m.avatar_hash
       FROM team_members t JOIN members m ON m.discord_id = t.discord_id
       ORDER BY t.joined_at ASC`,
    )
    .all<TeamMemberRow>();
  return results;
}

export async function addTeamMember(
  db: D1Database,
  teamId: number,
  discordId: string,
  position: string | null,
  now: number,
): Promise<void> {
  const team = await getTeam(db, teamId);
  if (!team || !team.active) throw new RuleError('missing', `No active team with id ${teamId}.`);
  await db
    .prepare(
      `INSERT INTO team_members (team_id, discord_id, position, joined_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (team_id, discord_id) DO UPDATE SET position = ?3`,
    )
    .bind(teamId, discordId, position, now)
    .run();
}

export async function removeTeamMember(db: D1Database, teamId: number, discordId: string): Promise<void> {
  await db
    .prepare('DELETE FROM team_members WHERE team_id = ?1 AND discord_id = ?2')
    .bind(teamId, discordId)
    .run();
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
