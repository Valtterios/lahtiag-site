// All D1 access, one exported function per operation (spec, Repository
// layout): a web form, a slash command and a future external bot share this
// one copy of the validation. Routes and command handlers never contain SQL.

import type { D1Database } from '@cloudflare/workers-types';
import type { ApplicationInput, Honour, MemberType, RegisterStatus } from './register';
import { deriveMemberType, searchKey } from './register';
import { newTicketCode } from './qr';
import { imageSize } from './images';
import { QUESTION_LIMITS, questionOptions, type EventQuestionRow, type QuestionKind } from './questions';

export class RuleError extends Error {
  constructor(
    public code:
      | 'missing'
      | 'cancelled'
      | 'full'
      | 'started'
      | 'bad_input'
      | 'bad_name' // a Minecraft name: 3 to 16 letters, digits or underscores
      | 'name_taken'
      | 'not_member'
      | 'friend_limit'
      | 'no_account' // no Minecraft account has that name
      | 'mojang_down'
      | 'has_name'
      | 'team_full'
      | 'dup_name'
      | 'not_team_event'
      | 'not_linked' // a member with no Discord account to add them as
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
      | 'ticket_holder'
      | 'too_few'
  | 'team_size'
  | 'team_reserves'
  | 'not_captain'
  | 'has_sales'
  | 'not_open'
  | 'not_full'
  | 'no_waitlist'
  | 'bad_seeding'
  | 'bracket_live'
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
  team_reserves: number; // places a team has beyond team_size: the bench
  organizers: string | null; // comma-separated free-text names
  location: string | null; // venue, free text
  published_at: number | null; // null: a draft only the board sees
  link_url: string | null; // optional stream/info link
  display_note: string | null; // live message for the venue display
  ping: string | null; // who the announcement pings: null, 'everyone', or a role id
  photo_credit: string | null; // who took the photos, shown under them
  cancel_message_id: string | null; // the Discord "cancelled" post, removed on reinstate
  members_only: number; // 1 = signups and tickets need a linked, current member
  member_slots: number | null; // seats within capacity only members may take
  created_by: string;
  created_at: number;
  cancelled_at: number | null;
  signups_closed_at: number | null;
  discord_message_id: string | null;
  discord_role_id: string | null; // the event's own role, given to everyone on the roster (src/lib/event-discord.ts)
  discord_channel_id: string | null; // its private channel
  discord_event_id: string | null; // Discord's scheduled event, made on publish
  discord_category_id: string | null; // a big event's own category; null = one channel under the shared Events category
  discord_bracket_message_id: string | null; // legacy, unused: brackets.discord_message_id took over
  bracket_live_at: number | null; // legacy, unused: brackets.live_at took over
  signups_open_at: number | null; // null = from publication; else signups and sales wait for this moment
  signups_close_at: number | null; // null = until the board closes them; else the job closes them at this moment
  interest_synced_at: number | null; // last time Discord's Interested clicks were read
  reminder_sent_at: number | null; // the hourly job's day-before reminder, once
  open_posted_at: number | null; // the hourly job's "signups are open" post, once
  sales_reminder_sent_at: number | null; // the hourly job's "sales close tomorrow" line, once
}

export interface EventWithCounts extends EventRow {
  yes_count: number;
  maybe_count: number;
  reserves_count: number; // of the yes count, the ones sitting on a team's bench
  teams_count: number;
  interest_count: number; // people interested, on the site or on Discord, each once
  ticket_types: number; // ticket types on sale: 0 means a signup event
  from_cents: number | null; // the cheapest that costs something, for "from 8.00 €"
  from_member_cents: number | null; // the same at a member's price
  to_cents: number | null; // the dearest, for the shop's price range
  to_member_cents: number | null;
}

export interface SignupRow {
  discord_id: string;
  status: 'yes' | 'maybe';
  created_at: number;
  event_team_id: number | null;
  reserve: number; // 1 = on the team's bench rather than in its starting line-up
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
  discord_message_id: string | null; // the first text message on Discord
  discord_messages: string | null; // every Discord message of the post, JSON (src/lib/news.ts)
  author_name: string | null;
  draft: number; // 1 until the board publishes it (and it goes to Discord)
  publish_at: number | null; // a draft with a time: the 15-minute job publishes it then
  ping: string | null; // who the Discord post pings: null, 'everyone', or a role id
  cover_at?: number | null; // the cover's upload time (the image URL's version), from listAnnouncements
  cover_w?: number | null; // its pixel size, so the page reserves the right box
  cover_h?: number | null;
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
    (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status = 'yes' AND s.reserve = 1) AS reserves_count,
    (SELECT COUNT(*) FROM event_teams t WHERE t.event_id = e.id)                    AS teams_count,
    (SELECT COUNT(DISTINCT i.discord_id) FROM event_interest i WHERE i.event_id = e.id) AS interest_count,
    (SELECT COUNT(*) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.active = 1) AS ticket_types,
    -- the cheapest seat that costs something, and the same at a member's
    -- price; both null when every ticket on sale is free
    (SELECT MIN(tt.price_cents) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.active = 1 AND tt.price_cents > 0) AS from_cents,
    (SELECT MIN(COALESCE(tt.member_price_cents, tt.price_cents)) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.active = 1 AND tt.price_cents > 0) AS from_member_cents,
    (SELECT MAX(tt.price_cents) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.active = 1 AND tt.price_cents > 0) AS to_cents,
    (SELECT MAX(COALESCE(tt.member_price_cents, tt.price_cents)) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.active = 1 AND tt.price_cents > 0) AS to_member_cents
  FROM events e`;

// Drafts are the board's alone until published: they stay out of every
// public list, the feed, the sitemap and Discord.
export async function listUpcomingEvents(db: D1Database, now: number, includeDrafts = false): Promise<EventWithCounts[]> {
  const { results } = await db
    .prepare(
      `${EVENT_COUNTS} WHERE e.cancelled_at IS NULL ${includeDrafts ? '' : 'AND e.published_at IS NOT NULL'}
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
      `${EVENT_COUNTS} WHERE e.cancelled_at IS NULL AND e.published_at IS NOT NULL AND e.starts_at < ?1
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
  location?: string | null;
}): void {
  capLength(input.title.trim(), 120, 'A title');
  capLength(input.description, 2000, 'A description');
  capLength(input.organizers ?? null, 120, 'The organizers line');
  capLength(input.location ?? null, 120, 'The location');
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
    team_reserves?: number | null;
    organizers?: string | null;
    location?: string | null;
    link_url?: string | null;
    members_only?: boolean;
    member_slots?: number | null;
    created_by: string;
    published?: boolean; // false: a draft, until publishEvent
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
  const teamReserves = teamSize === null ? 0 : checkReserves(input.team_reserves ?? 0);
  const memberSlots = checkMemberSlots(input.member_slots ?? null, input.capacity, teamSize);
  const organizers = input.organizers?.trim() || null;
  const endsAt = input.ends_at ?? null;
  if (endsAt !== null && endsAt <= input.starts_at) {
    throw new RuleError('bad_input', 'The end must be after the start.');
  }
  const linkUrl = normalizeLink(input.link_url);
  const row = await db
    .prepare(
      `INSERT INTO events (title, description, starts_at, ends_at, capacity, team_size, team_reserves, organizers, link_url, created_by, created_at, members_only, member_slots, location, published_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) RETURNING id`,
    )
    .bind(
      input.title.trim(),
      input.description,
      input.starts_at,
      endsAt,
      input.capacity,
      teamSize,
      teamReserves,
      organizers,
      linkUrl,
      input.created_by,
      now,
      input.members_only ? 1 : 0,
      memberSlots,
      input.location?.trim() || null,
      input.published === false ? null : now,
    )
    .first<{ id: number }>();
  return row!.id;
}

// A draft goes public: from now on it lists, takes signups and sells.
export async function publishEvent(db: D1Database, id: number, now: number): Promise<EventWithCounts> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  if (event.published_at === null) {
    await db.prepare('UPDATE events SET published_at = ?2 WHERE id = ?1').bind(id, now).run();
  }
  return (await getEvent(db, id))!;
}

// Signups survive edits; a capacity lowered below the current count keeps
// existing signups and only blocks new ones. The team size can change as
// long as no existing team ends up over it (and cannot be cleared while
// teams exist); any bracket is dropped, since its shape no longer fits.
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
    location?: string | null;
    link_url: string | null;
    members_only?: boolean;
    member_slots?: number | null;
    team_size?: number | null; // undefined: unchanged
    team_reserves?: number | null; // undefined: unchanged
  },
): Promise<EventWithCounts> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  let teamSize = event.team_size;
  if (input.team_size !== undefined && input.team_size !== event.team_size) {
    if (input.team_size !== null && (!Number.isInteger(input.team_size) || input.team_size < 1)) {
      throw new RuleError('bad_input', 'A team size is a positive whole number.');
    }
    const teams = await db.prepare('SELECT COUNT(*) AS n FROM event_teams WHERE event_id = ?1').bind(id).first<{ n: number }>();
    if (input.team_size === null && (teams?.n ?? 0) > 0) throw new RuleError('team_size', 'Disband the teams before making this an individual event.');
    teamSize = input.team_size;
  }
  // The bench grows freely; either limit shrinks only as far as the
  // fullest team allows, so nobody is thrown off a team by an edit.
  let teamReserves = event.team_reserves;
  const sizeChanged = input.team_size !== undefined && input.team_size !== event.team_size;
  const reservesChanged = input.team_reserves !== undefined && checkReserves(input.team_reserves ?? 0) !== event.team_reserves;
  if (input.team_reserves !== undefined) teamReserves = checkReserves(input.team_reserves ?? 0);
  if (teamSize === null) teamReserves = 0;
  if (teamSize !== null && (sizeChanged || reservesChanged)) {
    const biggest = await db
      .prepare('SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND event_team_id IS NOT NULL GROUP BY event_team_id)')
      .bind(id)
      .first<{ n: number }>();
    if ((biggest?.n ?? 0) > teamSize + teamReserves) {
      throw sizeChanged
        ? new RuleError('team_size', 'A team already has more members than that.')
        : new RuleError('team_reserves', 'A team already has more members than that leaves room for. Take somebody off the team first.');
    }
  }
  const memberSlots = checkMemberSlots(input.member_slots ?? null, input.capacity, teamSize);
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
         members_only = ?9, member_slots = ?10, location = ?11, team_size = ?12, team_reserves = ?13
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
      input.location?.trim() || null,
      teamSize,
      teamReserves,
    )
    .run();
  // A changed team size makes every bracket the wrong shape: they go, to
  // be redrawn. Reserves never enter a draw, so they leave it alone.
  if (teamSize !== event.team_size) await deleteEventBrackets(db, id);
  // Nobody sits on a bench that is no longer there.
  if (teamReserves === 0 && event.team_reserves !== 0) {
    await db.prepare('UPDATE signups SET reserve = 0 WHERE event_id = ?1').bind(id).run();
  }
  // A smaller line-up: the last to join each team take the bench, rather
  // than leaving a team fielding more players than the event allows.
  if (teamSize !== null && event.team_size !== null && teamSize < event.team_size) {
    await db
      .prepare(
        `UPDATE signups SET reserve = 1
          WHERE event_id = ?1 AND event_team_id IS NOT NULL AND reserve = 0
            AND rowid NOT IN (
              SELECT s2.rowid FROM signups s2
               WHERE s2.event_id = ?1 AND s2.event_team_id = signups.event_team_id AND s2.reserve = 0
               ORDER BY s2.created_at ASC, s2.rowid ASC LIMIT ?2)`,
      )
      .bind(id, teamSize)
      .run();
  }
  // A raised capacity lets the waitlist in.
  await promoteWaitlist(db, id);
  return (await getEvent(db, id))!;
}

export async function cancelEvent(db: D1Database, id: number, now: number): Promise<EventRow> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'Already cancelled.');
  await db.prepare('UPDATE events SET cancelled_at = ?1 WHERE id = ?2').bind(now, id).run();
  return event;
}

export async function setCancelMessageId(db: D1Database, id: number, messageId: string | null): Promise<void> {
  await db.prepare('UPDATE events SET cancel_message_id = ?2 WHERE id = ?1').bind(id, messageId).run();
}

// The undo of cancelEvent: signups, teams, tickets and bracket were never
// touched by cancelling, so putting the event back is one column.
export async function uncancelEvent(db: D1Database, id: number): Promise<EventRow> {
  const event = await getEvent(db, id);
  if (!event) throw new RuleError('missing', `No event with id ${id}.`);
  if (event.cancelled_at === null) throw new RuleError('bad_input', 'This event is not cancelled.');
  await db.prepare('UPDATE events SET cancelled_at = NULL WHERE id = ?1').bind(id).run();
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
  await db.prepare('DELETE FROM event_covers WHERE event_id = ?1').bind(id).run();
  await db.prepare('DELETE FROM door_payments WHERE ticket_id IN (SELECT id FROM tickets WHERE event_id = ?1)').bind(id).run();
  await db.prepare('DELETE FROM tickets WHERE event_id = ?1').bind(id).run();
  await db.prepare('DELETE FROM ticket_types WHERE event_id = ?1').bind(id).run();
  await db.batch([
    db.prepare('DELETE FROM bracket_matches WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM brackets WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM event_role_grants WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM event_discord_channels WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM event_interest WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM event_waitlist WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM event_photos WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM waitlist_promotions WHERE event_id = ?1').bind(id),
    // A tick given for the event stays with the member, without the event.
    db.prepare('UPDATE ticks SET event_id = NULL WHERE event_id = ?1').bind(id),
    db.prepare('UPDATE tick_claims SET event_id = NULL WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM signups WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM event_teams WHERE event_id = ?1').bind(id),
    db.prepare('DELETE FROM events WHERE id = ?1').bind(id),
  ]);
  return event;
}

// Who the announcement pings, chosen on the Publish card and kept for a
// repost. Validated by the caller (src/lib/news.ts, parsePing).
export async function setEventPing(db: D1Database, id: number, ping: string | null): Promise<void> {
  await db.prepare('UPDATE events SET ping = ?2 WHERE id = ?1').bind(id, ping).run();
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
  if (event.published_at === null) throw new RuleError('closed', 'This event is not published yet.');
  if (!signupsOpen(event, now)) throw new RuleError('not_open', 'Signups are not open yet.');
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
  const wasIn = event.team_size !== null ? await teamOf(db, eventId, discordId) : null;
  await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id, reserve)
       VALUES (?1, ?2, ?3, ?4, NULL, 0)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = ?3, event_team_id = NULL, reserve = 0`,
    )
    .bind(eventId, discordId, status, now)
    .run();
  await dropTeamIfEmpty(db, eventId, wasIn);
  // Stepping back to maybe frees a seat for the waitlist.
  if (status === 'maybe') await promoteWaitlist(db, eventId, now);
}

export async function removeSignup(db: D1Database, eventId: number, discordId: string): Promise<void> {
  const event = await getEvent(db, eventId);
  if (event?.signups_closed_at != null) throw new RuleError('closed', 'Signups are closed.');
  // A paid ticket is the signup; leaving means a refund, from the board.
  if (await isTicketed(db, eventId)) throw new RuleError('needs_ticket', 'Ticket holders leave through a refund.');
  const wasIn = await teamOf(db, eventId, discordId);
  await db
    .prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .run();
  await dropTeamIfEmpty(db, eventId, wasIn);
  await promoteWaitlist(db, eventId);
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

// The photographer(s), a short line under the event's photos; empty clears it.
export async function setPhotoCredit(db: D1Database, eventId: number, credit: string | null): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const text = credit?.trim() || null;
  capLength(text, 120, 'A photo credit');
  await db.prepare('UPDATE events SET photo_credit = ?2 WHERE id = ?1').bind(eventId, text).run();
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
  reserve?: boolean, // undefined: wherever the team has room
): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const existing = await db
    .prepare('SELECT 1 AS x FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .first();
  if (!existing) throw new RuleError('missing', 'No such signup on this event.');
  if (status !== 'yes' && (await hasPaidTicket(db, eventId, discordId))) {
    throw new RuleError('ticket_holder', 'This person holds a paid ticket; they are going.');
  }
  let teamId = eventTeamId;
  let bench = 0;
  if (teamId !== null) {
    if (event.team_size === null) {
      throw new RuleError('not_team_event', 'This event does not take team signups.');
    }
    const team = await db
      .prepare('SELECT id FROM event_teams WHERE id = ?1 AND event_id = ?2')
      .bind(teamId, eventId)
      .first();
    if (!team) throw new RuleError('missing', 'No such team on this event.');
    bench = await placeInTeam(db, event, teamId, discordId, reserve);
    status = 'yes';
  } else if (status === 'maybe') {
    teamId = null;
  }
  const wasIn = await teamOf(db, eventId, discordId);
  await db
    .prepare(
      'UPDATE signups SET status = ?3, event_team_id = ?4, reserve = ?5 WHERE event_id = ?1 AND discord_id = ?2',
    )
    .bind(eventId, discordId, status, teamId, bench)
    .run();
  if (wasIn !== teamId) await dropTeamIfEmpty(db, eventId, wasIn);
  if (status === 'maybe') await promoteWaitlist(db, eventId);
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
  let bench = 0;
  if (eventTeamId !== null) {
    if (event.team_size === null) {
      throw new RuleError('not_team_event', 'This event does not take team signups.');
    }
    const team = await db
      .prepare('SELECT id FROM event_teams WHERE id = ?1 AND event_id = ?2')
      .bind(eventTeamId, eventId)
      .first();
    if (!team) throw new RuleError('missing', 'No such team on this event.');
    bench = await placeInTeam(db, event, eventTeamId, null);
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
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id, reserve)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(eventId, discordId, status, now, eventTeamId, bench)
    .run();
  return discordId;
}

// Board: put an actual member on the roster, against their own Discord
// account. The walk-in above mints a synthetic id, which is right for a
// stranger at the door but wrong for a member: the placeholder holds no
// role, no ticks and no stats, and never joins up with the person later.
// This is the one the board wants nearly every time — a member who has not
// signed up, or who signed up without a team, being put where they belong
// — so an existing signup is moved rather than refused.
export async function addMemberParticipant(
  db: D1Database,
  eventId: number,
  registerId: number,
  status: 'yes' | 'maybe',
  eventTeamId: number | null,
  now: number,
): Promise<string> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const member = await db
    .prepare("SELECT full_name, discord_id, discord_name FROM register WHERE id = ?1 AND status = 'member'")
    .bind(registerId)
    .first<{ full_name: string; discord_id: string | null; discord_name: string | null }>();
  if (!member) throw new RuleError('missing', 'No current member with that entry.');
  if (!member.discord_id) {
    throw new RuleError('not_linked', 'That member has no Discord account linked yet, so there is nothing to add them as.');
  }
  const discordId = member.discord_id;
  const existing = await db
    .prepare('SELECT event_team_id FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .first<{ event_team_id: number | null }>();
  let bench = 0;
  if (eventTeamId !== null) {
    if (event.team_size === null) throw new RuleError('not_team_event', 'This event does not take team signups.');
    const team = await db
      .prepare('SELECT id FROM event_teams WHERE id = ?1 AND event_id = ?2')
      .bind(eventTeamId, eventId)
      .first();
    if (!team) throw new RuleError('missing', 'No such team on this event.');
    // Counted without them, the way adminUpdateSignup counts it: moving
    // someone into the team they are already in is not one more body.
    bench = await placeInTeam(db, event, eventTeamId, discordId);
    status = 'yes';
  }
  // The roster reads names from the member cache, so it needs a row; a
  // member who has signed in already has one, and this leaves it alone.
  await db
    .prepare(
      `INSERT INTO members (discord_id, username, avatar_hash, last_seen)
       VALUES (?1, ?2, NULL, ?3)
       ON CONFLICT (discord_id) DO NOTHING`,
    )
    .bind(discordId, member.discord_name ?? member.full_name, now)
    .run();
  if (existing) {
    await db
      .prepare('UPDATE signups SET status = ?3, event_team_id = ?4, reserve = ?5 WHERE event_id = ?1 AND discord_id = ?2')
      .bind(eventId, discordId, status, eventTeamId, bench)
      .run();
  } else {
    await db
      .prepare('INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id, reserve) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(eventId, discordId, status, now, eventTeamId, bench)
      .run();
  }
  // On the roster and on the waitlist at once would be nonsense.
  await db.prepare('DELETE FROM event_waitlist WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, discordId).run();
  const wasIn = existing?.event_team_id ?? null;
  if (wasIn !== eventTeamId) await dropTeamIfEmpty(db, eventId, wasIn);
  return discordId;
}

// Admin removal skips the signups-closed guard: pruning a no-show or a
// banned member off the roster is exactly a closed-signups activity.
export async function adminRemoveSignup(
  db: D1Database,
  eventId: number,
  discordId: string,
): Promise<void> {
  // A paid ticket is the signup: leaving goes through a refund in Stripe.
  if (await hasPaidTicket(db, eventId, discordId)) throw new RuleError('ticket_holder', 'This person holds a paid ticket.');
  const wasIn = await teamOf(db, eventId, discordId);
  await db
    .prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .run();
  await dropTeamIfEmpty(db, eventId, wasIn);
  await promoteWaitlist(db, eventId);
}

// Erase a member everywhere: every signup and team membership goes, empty
// teams disband, and the cached member row is deleted — or anonymized when
// foreign keys still need it (they created events, teams, or announcements).
// Bracket history keeps the slot but renders as Unknown. This is both the
// ban cleanup and the GDPR-erasure path.
export async function purgeMember(db: D1Database, discordId: string): Promise<'deleted' | 'anonymized'> {
  const { results: affected } = await db
    .prepare('SELECT DISTINCT event_id AS id, event_team_id FROM signups WHERE discord_id = ?1')
    .bind(discordId)
    .all<{ id: number; event_team_id: number | null }>();
  await db.prepare('DELETE FROM signups WHERE discord_id = ?1').bind(discordId).run();
  await db.prepare('DELETE FROM event_waitlist WHERE discord_id = ?1').bind(discordId).run();
  for (const row of affected) await dropTeamIfEmpty(db, row.id, row.event_team_id);
  for (const row of affected) await promoteWaitlist(db, row.id);
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

// Reopening also drops a closing time that has already been and gone,
// or the job would shut the door again a quarter of an hour later.
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
  if (!closed && event.signups_close_at !== null && event.signups_close_at <= now) {
    await setSignupsCloseAt(db, eventId, null);
  }
}

// --- tournament team signups -----------------------------------------------

// Signups (and sales) wait for the opening moment when one is set.
export function signupsOpen(event: Pick<EventRow, 'signups_open_at'>, now: number): boolean {
  return event.signups_open_at === null || event.signups_open_at <= now;
}

async function requireOpenTeamEvent(db: D1Database, eventId: number, now?: number): Promise<EventWithCounts> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'This event is cancelled.');
  if (now !== undefined && !signupsOpen(event, now)) throw new RuleError('not_open', 'Signups are not open yet.');
  if (event.signups_closed_at !== null) throw new RuleError('closed', 'Signups are closed.');
  if (event.team_size === null) {
    throw new RuleError('not_team_event', 'This event does not take team signups.');
  }
  return event;
}

// A team with no members left is deleted rather than lingering as an empty
// name squatting on the roster (and, on capped events, on a team slot).
// A team disbands when its own last member leaves — never because some
// other team on the event happens to be empty. Sweeping every empty team
// on any roster edit deleted two kinds of team that are empty on purpose:
// the ones the board makes to assign people into, and the ones a bracket
// imported from an old tournament that never had a roster. Both went the
// moment anybody was moved, and the bracket was left pointing at teams
// that no longer existed.
async function dropTeamIfEmpty(db: D1Database, eventId: number, teamId: number | null): Promise<void> {
  if (teamId === null) return;
  const left = await db
    .prepare('SELECT 1 AS x FROM signups WHERE event_id = ?1 AND event_team_id = ?2 LIMIT 1')
    .bind(eventId, teamId)
    .first();
  if (!left) await db.prepare('DELETE FROM event_teams WHERE id = ?1 AND event_id = ?2').bind(teamId, eventId).run();
}

// How full a team is, told apart: the starting line-up and the bench.
// `exclude` leaves one person out of the count, which is what moving
// somebody who is already in the team means.
interface TeamPlaces {
  starters: number;
  reserves: number;
}

async function teamPlaces(db: D1Database, eventId: number, teamId: number, exclude: string | null): Promise<TeamPlaces> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN reserve = 0 THEN 1 ELSE 0 END), 0) AS starters,
              COALESCE(SUM(CASE WHEN reserve = 1 THEN 1 ELSE 0 END), 0) AS reserves
         FROM signups WHERE event_id = ?1 AND event_team_id = ?2 AND discord_id != ?3`,
    )
    .bind(eventId, teamId, exclude ?? '')
    .first<TeamPlaces>();
  return { starters: row?.starters ?? 0, reserves: row?.reserves ?? 0 };
}

// Where the next player goes. Two limits, and only two: a team fields
// team_size players, and carries team_size + team_reserves of them in
// all. The bench is simply everyone else, with no count of its own —
// which is what makes switching possible. Sending a starter to the bench
// is always allowed; bringing a reserve on waits for room in the
// line-up, so a swap is: bench one, bring the other on.
//
// Left to itself the line-up fills first and the bench takes the rest,
// so the sixth player on a five-a-side event with one reserve place
// joins as the reserve rather than being turned away. `want` is the
// board (or the captain) saying which of the two it is to be.
async function placeInTeam(
  db: D1Database,
  event: Pick<EventRow, 'id' | 'team_size' | 'team_reserves'>,
  teamId: number,
  exclude: string | null,
  want?: boolean,
): Promise<number> {
  const places = await teamPlaces(db, event.id, teamId, exclude);
  const lineUpRoom = places.starters < (event.team_size ?? 0);
  const teamRoom = places.starters + places.reserves < (event.team_size ?? 0) + event.team_reserves;
  if (want === true) {
    if (!teamRoom) throw new RuleError('team_full', 'That team is already full.');
    if (event.team_reserves === 0) throw new RuleError('team_full', 'This event has no reserve places.');
    return 1;
  }
  if (want === false) {
    if (!lineUpRoom) throw new RuleError('team_full', "That team's line-up is full. Send somebody to the bench first.");
    return 0;
  }
  if (lineUpRoom) return 0;
  if (teamRoom) return 1;
  throw new RuleError('team_full', event.team_reserves > 0 ? 'That team is full, bench included.' : 'That team is already full.');
}

// The team someone is in right now, read before a change so the change can
// tidy up after itself.
async function teamOf(db: D1Database, eventId: number, discordId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT event_team_id FROM signups WHERE event_id = ?1 AND discord_id = ?2')
    .bind(eventId, discordId)
    .first<{ event_team_id: number | null }>();
  return row?.event_team_id ?? null;
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
  const event = await requireOpenTeamEvent(db, eventId, now);
  // Making a team, or joining one, takes a place: on a team event the
  // reserved seats hold line-up places for members like any other.
  await requireEligible(db, event, discordId, true);
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
  const event = await requireOpenTeamEvent(db, eventId, now);
  await requireEligible(db, event, discordId, true);
  await requireTicketIfTicketed(db, eventId, discordId);
  const team = await db
    .prepare('SELECT * FROM event_teams WHERE id = ?1 AND event_id = ?2')
    .bind(eventTeamId, eventId)
    .first<EventTeamRow>();
  if (!team) throw new RuleError('missing', 'No such team on this event.');
  // A full line-up is not a full team while the bench has room.
  const bench = await placeInTeam(db, event, eventTeamId, discordId);
  const wasIn = await teamOf(db, eventId, discordId);
  await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id, reserve)
       VALUES (?1, ?2, 'yes', ?3, ?4, ?5)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = 'yes', event_team_id = ?4, reserve = ?5`,
    )
    .bind(eventId, discordId, now, eventTeamId, bench)
    .run();
  // Switching teams may have emptied the one they came from.
  if (wasIn !== eventTeamId) await dropTeamIfEmpty(db, eventId, wasIn);
}

// Leaving a team keeps the member signed up as a free agent.
export async function leaveEventTeam(db: D1Database, eventId: number, discordId: string): Promise<void> {
  const event = await getEvent(db, eventId);
  if (event?.signups_closed_at != null) throw new RuleError('closed', 'Signups are closed.');
  const wasIn = await teamOf(db, eventId, discordId);
  await db
    .prepare(
      'UPDATE signups SET event_team_id = NULL, reserve = 0 WHERE event_id = ?1 AND discord_id = ?2',
    )
    .bind(eventId, discordId)
    .run();
  await dropTeamIfEmpty(db, eventId, wasIn);
}

export async function listSignups(db: D1Database, eventId: number): Promise<SignupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.discord_id, s.status, s.created_at, s.event_team_id, s.reserve, m.username, m.avatar_hash,
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

// --- teams the board makes -------------------------------------------------

// The board makes a team with nobody in it yet, then assigns people under
// Manage participants. Only the team count is checked.
export async function adminCreateTeam(db: D1Database, eventId: number, name: string, by: string, now: number): Promise<number> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  if (event.team_size === null) throw new RuleError('not_team_event', 'This event does not take team signups.');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 40) throw new RuleError('bad_input', 'A team name is 1 to 40 characters.');
  const dup = await db.prepare('SELECT 1 AS x FROM event_teams WHERE event_id = ?1 AND lower(name) = lower(?2)').bind(eventId, trimmed).first();
  if (dup) throw new RuleError('dup_name', 'A team with that name already exists.');
  if (event.capacity !== null) {
    const teams = await db.prepare('SELECT COUNT(*) AS n FROM event_teams WHERE event_id = ?1').bind(eventId).first<{ n: number }>();
    if ((teams?.n ?? 0) >= event.capacity) throw new RuleError('team_full', 'All team slots for this event are taken.');
  }
  const row = await db
    .prepare(`INSERT INTO event_teams (event_id, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id`)
    .bind(eventId, trimmed, by, now)
    .first<{ id: number }>();
  return row!.id;
}

// On a team event, players who signed up without a team are grouped into
// teams of the event's size (the last one may be short) before the draw,
// named after their first player. Benches are left empty: a reserve is
// somebody a team picks, not a leftover. The board can still move people
// around under Manage participants and regenerate.
export async function autoTeamLoosePlayers(db: D1Database, eventId: number, now: number): Promise<number> {
  const event = await getEvent(db, eventId);
  if (!event || event.team_size === null) return 0;
  const loose = (await listSignups(db, eventId)).filter((s) => s.status === 'yes' && s.event_team_id === null);
  let made = 0;
  for (let i = 0; i < loose.length; i += event.team_size) {
    const group = loose.slice(i, i + event.team_size);
    const name = `Team ${group[0].username}`.slice(0, 40);
    const row = await db
      .prepare(`INSERT INTO event_teams (event_id, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id`)
      .bind(eventId, name, group[0].discord_id, now)
      .first<{ id: number }>();
    for (const s of group) {
      await db.prepare('UPDATE signups SET event_team_id = ?3 WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, s.discord_id, row!.id).run();
    }
    made++;
  }
  return made;
}

// Renaming a team carries everywhere the name is looked up: the roster,
// the brackets, the pictures, the channel (the caller renames that).
export async function renameEventTeam(db: D1Database, eventId: number, teamId: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 40) throw new RuleError('bad_input', 'A team name is 1 to 40 characters.');
  const team = await db.prepare('SELECT id FROM event_teams WHERE id = ?1 AND event_id = ?2').bind(teamId, eventId).first();
  if (!team) throw new RuleError('missing', 'No such team on this event.');
  const dup = await db
    .prepare('SELECT 1 AS x FROM event_teams WHERE event_id = ?1 AND lower(name) = lower(?2) AND id != ?3')
    .bind(eventId, trimmed, teamId)
    .first();
  if (dup) throw new RuleError('dup_name', 'A team with that name already exists.');
  await db.prepare('UPDATE event_teams SET name = ?2 WHERE id = ?1').bind(teamId, trimmed).run();
}

// --- tournament brackets ---------------------------------------------------
// Single elimination. Participant keys: 'u:<discord_id>' / 't:<event_team_id>'.
// An event runs as many brackets as it needs, each with its own name, its
// own draw and its own draft/live state: a main draw and a consolation,
// one bracket per game at a LAN, one per group. Nearly every event has
// exactly one, which is why the site goes on saying "the bracket" until a
// second one exists.

export interface BracketRow {
  id: number;
  event_id: number;
  name: string;
  live_at: number | null; // null = a draft only the board sees
  discord_message_id: string | null; // its own pinned live bracket
  created_at: number;
}

export interface BracketMatch {
  bracket_id: number;
  event_id: number;
  round: number;
  slot: number;
  side_a: string | null;
  side_b: string | null;
  winner: string | null;
}

// What an event's first bracket is called when the board doesn't say.
export const MAIN_BRACKET = 'Main bracket';

export async function listBrackets(db: D1Database, eventId: number): Promise<BracketRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM brackets WHERE event_id = ?1 ORDER BY created_at ASC, id ASC')
    .bind(eventId)
    .all<BracketRow>();
  return results;
}

export async function getBracketRow(db: D1Database, bracketId: number): Promise<BracketRow | null> {
  return db.prepare('SELECT * FROM brackets WHERE id = ?1').bind(bracketId).first<BracketRow>();
}

// What a request naming only an event means by "the bracket": the first
// one drawn, which on all but a handful of events is the only one. The
// links that predate names, and Discord's panel, both land here.
export async function mainBracket(db: D1Database, eventId: number): Promise<BracketRow | null> {
  return db
    .prepare('SELECT * FROM brackets WHERE event_id = ?1 ORDER BY created_at ASC, id ASC LIMIT 1')
    .bind(eventId)
    .first<BracketRow>();
}

// The one a page was asked for, falling back to the event's first: a
// stale ?b= in somebody's tab shows the event's bracket rather than an
// error, and never another event's.
export async function pickBracket(db: D1Database, eventId: number, bracketId: number | null): Promise<BracketRow | null> {
  if (bracketId === null || !Number.isInteger(bracketId)) return mainBracket(db, eventId);
  const row = await getBracketRow(db, bracketId);
  return row !== null && row.event_id === eventId ? row : mainBracket(db, eventId);
}

export async function getBracket(db: D1Database, bracketId: number): Promise<BracketMatch[]> {
  const { results } = await db
    .prepare('SELECT * FROM bracket_matches WHERE bracket_id = ?1 ORDER BY round, slot')
    .bind(bracketId)
    .all<BracketMatch>();
  return results;
}

async function checkBracketName(db: D1Database, eventId: number, name: string, exceptId: number | null): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 40) throw new RuleError('bad_input', 'A bracket name is 1 to 40 characters.');
  const duplicate = await db
    .prepare('SELECT 1 AS x FROM brackets WHERE event_id = ?1 AND lower(name) = lower(?2) AND id != ?3')
    .bind(eventId, trimmed, exceptId ?? 0)
    .first();
  if (duplicate) throw new RuleError('dup_name', 'This event already has a bracket by that name.');
  return trimmed;
}

// An empty bracket, named. Nothing is drawn into it yet; a nameless one
// is the Main bracket, then Bracket 2 and up.
export async function createBracket(db: D1Database, eventId: number, name: string | null, now: number): Promise<number> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const existing = await listBrackets(db, eventId);
  let wanted = (name ?? '').trim();
  if (!wanted) {
    const taken = new Set(existing.map((b) => b.name.toLowerCase()));
    wanted = existing.length === 0 ? MAIN_BRACKET : `Bracket ${existing.length + 1}`;
    for (let n = existing.length + 1; taken.has(wanted.toLowerCase()); n++) wanted = `Bracket ${n + 1}`;
  }
  const named = await checkBracketName(db, eventId, wanted, null);
  const row = await db
    .prepare('INSERT INTO brackets (event_id, name, live_at, discord_message_id, created_at) VALUES (?1, ?2, NULL, NULL, ?3) RETURNING id')
    .bind(eventId, named, now)
    .first<{ id: number }>();
  return row!.id;
}

export async function renameBracket(db: D1Database, bracketId: number, name: string): Promise<void> {
  const bracket = await getBracketRow(db, bracketId);
  if (!bracket) throw new RuleError('missing', 'No such bracket.');
  const named = await checkBracketName(db, bracket.event_id, name, bracketId);
  await db.prepare('UPDATE brackets SET name = ?2 WHERE id = ?1').bind(bracketId, named).run();
}

// Its matches go with it. Whatever Discord is pinning for it goes too,
// which the caller takes down first — the message id lives on the row.
export async function deleteBracket(db: D1Database, bracketId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM bracket_matches WHERE bracket_id = ?1').bind(bracketId),
    db.prepare('DELETE FROM brackets WHERE id = ?1').bind(bracketId),
  ]);
}

export async function deleteEventBrackets(db: D1Database, eventId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM bracket_matches WHERE event_id = ?1').bind(eventId),
    db.prepare('DELETE FROM brackets WHERE event_id = ?1').bind(eventId),
  ]);
}

// Who there is to draw: the formed teams on a team event, everyone who
// said yes on a solo one. Reserves are inside their team and never enter
// a draw of their own.
export async function bracketPool(db: D1Database, eventId: number): Promise<string[]> {
  const event = await getEvent(db, eventId);
  if (!event) return [];
  return event.team_size !== null
    ? (await listEventTeams(db, eventId)).map((team) => `t:${team.id}`)
    : (await listSignups(db, eventId)).filter((signup) => signup.status === 'yes').map((signup) => `u:${signup.discord_id}`);
}

async function getMatch(db: D1Database, bracketId: number, round: number, slot: number) {
  return db
    .prepare('SELECT * FROM bracket_matches WHERE bracket_id = ?1 AND round = ?2 AND slot = ?3')
    .bind(bracketId, round, slot)
    .first<BracketMatch>();
}

// Removes a participant from every later-round position it had advanced to;
// used when an earlier result changes so stale progress never lingers.
async function removeFromDownstream(
  db: D1Database,
  bracketId: number,
  round: number,
  slot: number,
  key: string,
  totalRounds: number,
): Promise<void> {
  if (round >= totalRounds) return;
  const nextRound = round + 1;
  const nextSlot = slot >> 1;
  const side = slot % 2 === 0 ? 'side_a' : 'side_b';
  const match = await getMatch(db, bracketId, nextRound, nextSlot);
  if (!match || match[side as 'side_a' | 'side_b'] !== key) return;
  await db
    .prepare(
      `UPDATE bracket_matches SET ${side} = NULL, winner = CASE WHEN winner = ?4 THEN NULL ELSE winner END
       WHERE bracket_id = ?1 AND round = ?2 AND slot = ?3`,
    )
    .bind(bracketId, nextRound, nextSlot, key)
    .run();
  await removeFromDownstream(db, bracketId, nextRound, nextSlot, key, totalRounds);
}

// Places `key` on its side of the next-round match, evicting (and cascading
// away) whoever a changed result had put there before.
async function advance(
  db: D1Database,
  bracketId: number,
  round: number,
  slot: number,
  key: string,
  totalRounds: number,
): Promise<void> {
  if (round >= totalRounds) return;
  const nextRound = round + 1;
  const nextSlot = slot >> 1;
  const side = slot % 2 === 0 ? 'side_a' : 'side_b';
  const match = await getMatch(db, bracketId, nextRound, nextSlot);
  if (!match) return;
  const occupant = match[side as 'side_a' | 'side_b'];
  if (occupant === key) return;
  await db
    .prepare(
      `UPDATE bracket_matches SET ${side} = ?4, winner = CASE WHEN winner = ?5 THEN NULL ELSE winner END
       WHERE bracket_id = ?1 AND round = ?2 AND slot = ?3`,
    )
    .bind(bracketId, nextRound, nextSlot, key, occupant ?? '')
    .run();
  if (occupant) await removeFromDownstream(db, bracketId, nextRound, nextSlot, occupant, totalRounds);
}

// Draws this bracket from the event's participants: full 'yes' signups on
// a solo event, the formed teams on a team event. `entrants` narrows that
// to the ones the board ticked, which is how a second bracket takes half
// the field, or a plate takes the teams the main draw knocked out.
// Replaces whatever the bracket held. Byes auto-advance immediately.
export async function generateBracket(
  db: D1Database,
  bracketId: number,
  now = Math.floor(Date.now() / 1000),
  entrants?: string[],
): Promise<void> {
  const bracket = await getBracketRow(db, bracketId);
  if (!bracket) throw new RuleError('missing', 'No such bracket.');
  const event = await getEvent(db, bracket.event_id);
  if (!event) throw new RuleError('missing', `No event with id ${bracket.event_id}.`);

  let keys: string[];
  if (entrants === undefined) {
    // The whole field: players who never found a team are grouped into
    // one first, so nobody is left out of the draw.
    if (event.team_size !== null) await autoTeamLoosePlayers(db, event.id, now);
    keys = await bracketPool(db, event.id);
  } else {
    const pool = new Set(await bracketPool(db, event.id));
    keys = [...new Set(entrants)];
    if (keys.some((key) => !pool.has(key))) throw new RuleError('bad_input', 'Every entrant must be on the roster.');
  }
  if (keys.length < 2) {
    throw new RuleError('too_few', event.team_size !== null ? 'A bracket needs at least two teams.' : 'A bracket needs at least two participants.');
  }

  // Random seeding.
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }

  let size = 1;
  while (size < keys.length) size *= 2;
  const totalRounds = Math.log2(size);

  await db.prepare('DELETE FROM bracket_matches WHERE bracket_id = ?1').bind(bracketId).run();

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

  await writeBracket(db, bracket, matches, totalRounds);
  // A fresh draw is a draft: the board checks the seeding, then goes live.
  await db.prepare('UPDATE brackets SET live_at = NULL WHERE id = ?1').bind(bracketId).run();
}

// Naming and drawing in one, which is what adding a bracket is. A draw
// that cannot be made leaves no half-made bracket behind.
export async function addBracket(
  db: D1Database,
  eventId: number,
  name: string | null,
  now: number,
  entrants?: string[],
): Promise<number> {
  const bracketId = await createBracket(db, eventId, name, now);
  try {
    await generateBracket(db, bracketId, now, entrants);
  } catch (error) {
    await deleteBracket(db, bracketId);
    throw error;
  }
  return bracketId;
}

// Round one as given, the later rounds empty, and byes advanced on the
// spot. Shared by the random draw and the board's reseeding.
async function writeBracket(db: D1Database, bracket: BracketRow, matches: Array<[string | null, string | null]>, totalRounds: number): Promise<void> {
  const size = matches.length * 2;
  const statements = [];
  for (let slot = 0; slot < matches.length; slot++) {
    const [a, b] = matches[slot];
    statements.push(
      db
        .prepare(
          `INSERT INTO bracket_matches (bracket_id, event_id, round, slot, side_a, side_b, winner)
           VALUES (?1, ?2, 1, ?3, ?4, ?5, NULL)`,
        )
        .bind(bracket.id, bracket.event_id, slot, a, b),
    );
  }
  for (let round = 2; round <= totalRounds; round++) {
    for (let slot = 0; slot < size / 2 ** round; slot++) {
      statements.push(
        db
          .prepare(
            `INSERT INTO bracket_matches (bracket_id, event_id, round, slot, side_a, side_b, winner)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL)`,
          )
          .bind(bracket.id, bracket.event_id, round, slot),
      );
    }
  }
  await db.batch(statements);

  // Byes advance on the spot.
  for (let slot = 0; slot < matches.length; slot++) {
    const [a, b] = matches[slot];
    if (a !== null && b === null) {
      await db
        .prepare(
          'UPDATE bracket_matches SET winner = ?4 WHERE bracket_id = ?1 AND round = 1 AND slot = ?2 AND side_a = ?3',
        )
        .bind(bracket.id, slot, a, a)
        .run();
      await advance(db, bracket.id, 1, slot, a, totalRounds);
    }
  }
}

// The board's own seeding of a draft bracket: round one rearranged, every
// participant exactly once, the same number of byes (a bye is an empty
// second side). Results are wiped, which a draft has none of anyway.
export async function setBracketSeeding(
  db: D1Database,
  bracketId: number,
  roundOne: Array<[string | null, string | null]>,
): Promise<void> {
  const bracket = await getBracketRow(db, bracketId);
  if (!bracket) throw new RuleError('missing', 'No such bracket.');
  const current = (await getBracket(db, bracketId)).filter((m) => m.round === 1);
  if (current.length === 0) throw new RuleError('missing', 'No bracket to seed.');
  if (bracket.live_at !== null) throw new RuleError('bracket_live', 'The bracket is live; regenerate to start over.');
  const wanted = current.flatMap((m) => [m.side_a, m.side_b]).filter((k): k is string => k !== null).sort();
  const pairs = roundOne.map(([a, b]): [string | null, string | null] => (a === null && b !== null ? [b, null] : [a, b]));
  if (pairs.length !== current.length) throw new RuleError('bad_seeding', 'The seeding does not match the bracket.');
  const given = pairs.flat().filter((k): k is string => k !== null).sort();
  const same = given.length === wanted.length && given.every((k, i) => k === wanted[i]);
  if (!same || pairs.some(([a]) => a === null)) {
    throw new RuleError('bad_seeding', 'Every participant once, and the same number of byes.');
  }
  const totalRounds = Math.log2(current.length * 2);
  await db.prepare('DELETE FROM bracket_matches WHERE bracket_id = ?1').bind(bracketId).run();
  await writeBracket(db, bracket, pairs, totalRounds);
}

// Show the bracket to everyone. True when this call made it live.
export async function goLiveBracket(db: D1Database, bracketId: number, now: number): Promise<boolean> {
  const bracket = await getBracketRow(db, bracketId);
  if (!bracket) throw new RuleError('missing', 'No bracket to put live.');
  const any = await db.prepare('SELECT 1 AS x FROM bracket_matches WHERE bracket_id = ?1 LIMIT 1').bind(bracketId).first();
  if (!any) throw new RuleError('missing', 'No bracket to put live.');
  if (bracket.live_at !== null) return false;
  await db.prepare('UPDATE brackets SET live_at = ?2 WHERE id = ?1').bind(bracketId, now).run();
  return true;
}

// A substitute: one participant's place in the bracket, results included,
// goes to another who is on the roster but not in this draw (a walk-in
// added late, a team formed after the draw).
export async function replaceBracketParticipant(db: D1Database, bracketId: number, fromKey: string, toKey: string): Promise<void> {
  const bracket = await getBracketRow(db, bracketId);
  if (!bracket) throw new RuleError('missing', 'No such bracket.');
  const matches = await getBracket(db, bracketId);
  const inDraw = new Set(matches.flatMap((m) => [m.side_a, m.side_b, m.winner]).filter((k): k is string => k !== null));
  if (!inDraw.has(fromKey)) throw new RuleError('missing', 'That participant is not in the bracket.');
  if (inDraw.has(toKey) || fromKey === toKey) throw new RuleError('bad_input', 'The substitute is already in the bracket.');
  const pool = await bracketPool(db, bracket.event_id);
  if (!pool.includes(toKey)) throw new RuleError('bad_input', 'The substitute must be on the roster.');
  await db.batch([
    db.prepare('UPDATE bracket_matches SET side_a = ?3 WHERE bracket_id = ?1 AND side_a = ?2').bind(bracketId, fromKey, toKey),
    db.prepare('UPDATE bracket_matches SET side_b = ?3 WHERE bracket_id = ?1 AND side_b = ?2').bind(bracketId, fromKey, toKey),
    db.prepare('UPDATE bracket_matches SET winner = ?3 WHERE bracket_id = ?1 AND winner = ?2').bind(bracketId, fromKey, toKey),
  ]);
}

export async function setBracketWinner(
  db: D1Database,
  bracketId: number,
  round: number,
  slot: number,
  winnerKey: string,
): Promise<void> {
  const match = await getMatch(db, bracketId, round, slot);
  if (!match) throw new RuleError('missing', 'No such match.');
  if (match.side_a === null || match.side_b === null) {
    throw new RuleError('bad_input', 'Both sides of the match must be known first.');
  }
  if (winnerKey !== match.side_a && winnerKey !== match.side_b) {
    throw new RuleError('bad_input', 'The winner must be one of the two sides.');
  }
  if (match.winner === winnerKey) return;
  const totals = await db
    .prepare('SELECT MAX(round) AS n FROM bracket_matches WHERE bracket_id = ?1')
    .bind(bracketId)
    .first<{ n: number }>();
  const totalRounds = totals!.n;
  await db
    .prepare(
      'UPDATE bracket_matches SET winner = ?4 WHERE bracket_id = ?1 AND round = ?2 AND slot = ?3',
    )
    .bind(bracketId, round, slot, winnerKey)
    .run();
  await advance(db, bracketId, round, slot, winnerKey, totalRounds);
}

// Reverts a recorded result: the match becomes undecided again and the
// former winner is pulled back out of every later round it had advanced to
// (including any results it won there, cascading). Bye "results" are
// automatic, not recorded, so a match missing a side cannot be reverted.
export async function clearBracketWinner(
  db: D1Database,
  bracketId: number,
  round: number,
  slot: number,
): Promise<void> {
  const match = await getMatch(db, bracketId, round, slot);
  if (!match) throw new RuleError('missing', 'No such match.');
  if (match.side_a === null || match.side_b === null) {
    throw new RuleError('bad_input', 'A bye cannot be reverted.');
  }
  if (match.winner === null) return;
  const totals = await db
    .prepare('SELECT MAX(round) AS n FROM bracket_matches WHERE bracket_id = ?1')
    .bind(bracketId)
    .first<{ n: number }>();
  const key = match.winner;
  await db
    .prepare(
      'UPDATE bracket_matches SET winner = NULL WHERE bracket_id = ?1 AND round = ?2 AND slot = ?3',
    )
    .bind(bracketId, round, slot)
    .run();
  await removeFromDownstream(db, bracketId, round, slot, key, totals!.n);
}

// Decided finals, newest first — the results archive. One row per bracket
// with a champion, so an event that ran a main draw and a plate leaves
// two. A draft's results stay with the board. The champion is resolved to
// a display name plus the avatars to show (team members' for a team
// champion, the player's own otherwise).
export interface ResultRow {
  event_id: number;
  bracket_id: number;
  bracket_name: string | null; // null when it is the event's only bracket
  title: string;
  starts_at: number;
  champion_name: string;
  avatars: { discord_id: string; avatar_hash: string | null }[];
}

export async function listResults(db: D1Database, limit = 20): Promise<ResultRow[]> {
  const { results: finals } = await db
    .prepare(
      `SELECT bm.event_id, bm.bracket_id, bm.winner, e.title, e.starts_at, br.name AS bracket_name,
              (SELECT COUNT(*) FROM brackets b3 WHERE b3.event_id = e.id) AS siblings
       FROM bracket_matches bm
       JOIN brackets br ON br.id = bm.bracket_id
       JOIN events e ON e.id = bm.event_id
       WHERE bm.winner IS NOT NULL
         AND e.cancelled_at IS NULL
         AND br.live_at IS NOT NULL
         AND bm.round = (SELECT MAX(round) FROM bracket_matches b2 WHERE b2.bracket_id = bm.bracket_id)
       ORDER BY e.starts_at DESC, br.created_at ASC, br.id ASC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ event_id: number; bracket_id: number; winner: string; title: string; starts_at: number; bracket_name: string; siblings: number }>();

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
        bracket_id: final.bracket_id,
        bracket_name: final.siblings > 1 ? final.bracket_name : null,
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
        bracket_id: final.bracket_id,
        bracket_name: final.siblings > 1 ? final.bracket_name : null,
        title: final.title,
        starts_at: final.starts_at,
        champion_name: member?.username ?? 'Unknown',
        avatars: member ? [{ discord_id: discordId, avatar_hash: member.avatar_hash }] : [],
      });
    }
  }
  return rows;
}

export async function listAnnouncements(db: D1Database, limit = 20, includeDrafts = false): Promise<AnnouncementRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, m.username AS author_name, c.updated_at AS cover_at, c.width AS cover_w, c.height AS cover_h
       FROM announcements a LEFT JOIN members m ON m.discord_id = a.author_id
       LEFT JOIN announcement_covers c ON c.announcement_id = a.id
       ${includeDrafts ? '' : 'WHERE a.draft = 0'}
       ORDER BY a.draft DESC, a.published_at DESC LIMIT ?1`,
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
  await db.batch([
    db.prepare('DELETE FROM announcement_covers WHERE announcement_id = ?1').bind(id),
    db.prepare('DELETE FROM announcements WHERE id = ?1').bind(id),
  ]);
  return row;
}

export async function getAnnouncement(db: D1Database, id: number): Promise<AnnouncementRow | null> {
  return db.prepare('SELECT a.*, NULL AS author_name FROM announcements a WHERE id = ?1').bind(id).first<AnnouncementRow>();
}

// The board rewrites a post, draft or published; the caller mirrors a
// published one onto its Discord message.
// The ping and the publish time only change on a draft: a published
// post has pinged and gone out already.
export async function updateAnnouncement(
  db: D1Database,
  id: number,
  input: { title: string; body_md: string; ping?: string | null; publish_at?: number | null },
): Promise<AnnouncementRow | null> {
  const title = input.title.trim();
  if (!title || !input.body_md.trim()) throw new RuleError('bad_input', 'An announcement needs a title and a body.');
  capLength(title, 120, 'A title');
  capLength(input.body_md, 4000, 'An announcement body');
  const row = await getAnnouncement(db, id);
  if (!row) return null;
  const ping = row.draft === 1 && input.ping !== undefined ? input.ping : row.ping;
  const publishAt = row.draft === 1 && input.publish_at !== undefined ? input.publish_at : row.publish_at;
  await db.prepare('UPDATE announcements SET title = ?2, body_md = ?3, ping = ?4, publish_at = ?5 WHERE id = ?1').bind(id, title, input.body_md, ping, publishAt).run();
  return { ...row, title, body_md: input.body_md, ping, publish_at: publishAt };
}

export async function createAnnouncement(
  db: D1Database,
  input: { title: string; body_md: string; author_id: string; source: 'web' | 'discord'; draft?: boolean; publish_at?: number | null; ping?: string | null },
  now: number,
): Promise<number> {
  if (!input.title.trim() || !input.body_md.trim()) {
    throw new RuleError('bad_input', 'An announcement needs a title and a body.');
  }
  capLength(input.title.trim(), 120, 'A title');
  capLength(input.body_md, 4000, 'An announcement body');
  const row = await db
    .prepare(
      `INSERT INTO announcements (title, body_md, published_at, author_id, source, draft, publish_at, ping)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
    )
    .bind(input.title.trim(), input.body_md, now, input.author_id, input.source, input.draft ? 1 : 0, input.draft ? (input.publish_at ?? null) : null, input.ping ?? null)
    .first<{ id: number }>();
  return row!.id;
}

// Drafts whose publish time has come (the 15-minute job).
export async function listDueAnnouncements(db: D1Database, now: number): Promise<AnnouncementRow[]> {
  const { results } = await db
    .prepare('SELECT a.*, NULL AS author_name FROM announcements a WHERE a.draft = 1 AND a.publish_at IS NOT NULL AND a.publish_at <= ?1 ORDER BY a.publish_at')
    .bind(now)
    .all<AnnouncementRow>();
  return results;
}

// A draft goes public, dated now.
export async function publishAnnouncement(db: D1Database, id: number, now: number): Promise<AnnouncementRow | null> {
  const row = await db.prepare('SELECT a.*, NULL AS author_name FROM announcements a WHERE id = ?1').bind(id).first<AnnouncementRow>();
  if (!row) return null;
  if (row.draft === 1) {
    await db.prepare('UPDATE announcements SET draft = 0, published_at = ?2 WHERE id = ?1').bind(id, now).run();
  }
  return { ...row, draft: 0, published_at: row.draft === 1 ? now : row.published_at };
}

// The post's Discord messages: the first text part is the id the rest
// of the code checks, the whole set is kept for edits and deletes.
export async function setAnnouncementMessages(db: D1Database, id: number, messages: { image: string | null; parts: string[] }): Promise<void> {
  await db
    .prepare('UPDATE announcements SET discord_message_id = ?1, discord_messages = ?2 WHERE id = ?3')
    .bind(messages.parts[0] ?? messages.image, JSON.stringify({ image: messages.image, parts: messages.parts }), id)
    .run();
}

// Back to a draft: off the page, its Discord messages forgotten (the
// caller deletes them), the ping kept so Publish can send it again.
export async function unpublishAnnouncement(db: D1Database, id: number): Promise<AnnouncementRow | null> {
  const row = await getAnnouncement(db, id);
  if (!row || row.draft === 1) return null;
  await db
    .prepare('UPDATE announcements SET draft = 1, publish_at = NULL, discord_message_id = NULL, discord_messages = NULL WHERE id = ?1')
    .bind(id)
    .run();
  return row;
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
  honour: Honour | null; // founded the association, or sat on a past board: not a class, not a role, a fact
  active_since: number | null;
  active_by: string | null;
  board_note: string | null;
  // What the board asked the applicant to put right, and when. Unlike
  // board_note this is written to be read by them.
  fix_note: string | null;
  fix_asked_at: number | null;
  fix_asked_by: string | null;
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
  extra: { discord_id: string | null; board_note: string | null; member_type: MemberType; honour: Honour | null },
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
         search_key = ?16, honour = ?17
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
      extra.honour,
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

// Entries that may be the same person, each with the reasons: the same
// Discord account, the same email, the same email name, the same Discord
// handle, or the same surname (whole words only, accent-insensitively, so
// "Jin" never matches "Jingwen"). A hint on pending applications, not a
// rule; the board decides.
export interface SimilarEntry {
  entry: RegisterRow;
  reasons: string[];
}

export async function findSimilarEntries(
  db: D1Database,
  entry: { id: number; full_name: string; email: string; discord_name?: string | null; discord_id?: string | null },
): Promise<SimilarEntry[]> {
  const escape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const nameTokens = searchKey([entry.full_name]).split(' ').filter(Boolean);
  const lastName = nameTokens.length > 1 ? nameTokens[nameTokens.length - 1] : null;
  const surname = lastName && lastName.length >= 3 ? lastName : null;
  const email = searchKey([entry.email]);
  const local = email.split('@')[0] ?? '';
  const handle = searchKey([entry.discord_name ?? '']).replace(/^@/, '');
  const clauses: string[] = [];
  const binds: (string | number)[] = [entry.id];
  const add = (clause: string, value: string) => {
    binds.push(value);
    clauses.push(clause.replace('?N', `?${binds.length}`));
  };
  if (entry.discord_id) add('discord_id = ?N', entry.discord_id);
  if (email) add("(' ' || search_key || ' ') LIKE ?N ESCAPE '\\'", `% ${escape(email)} %`);
  if (local.length >= 4) add("(' ' || search_key || ' ') LIKE ?N ESCAPE '\\'", `% ${escape(local)}@%`);
  if (handle.length >= 3) add("(' ' || search_key || ' ') LIKE ?N ESCAPE '\\'", `% ${escape(handle)} %`);
  if (surname) add("(' ' || search_key || ' ') LIKE ?N ESCAPE '\\'", `% ${escape(surname)} %`);
  if (clauses.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT * FROM register WHERE id != ?1 AND (${clauses.join(' OR ')}) ORDER BY full_name COLLATE NOCASE LIMIT 8`)
    .bind(...binds)
    .all<RegisterDbRow>();
  const out: SimilarEntry[] = [];
  for (const row of results.map(fromDb)) {
    const reasons: string[] = [];
    const theirs = searchKey([row.full_name]).split(' ');
    const theirEmail = searchKey([row.email]);
    const theirHandle = searchKey([row.discord_name ?? '']).replace(/^@/, '');
    if (entry.discord_id && row.discord_id === entry.discord_id) reasons.push('same Discord account');
    if (email && theirEmail === email) reasons.push('same email');
    else if (local.length >= 4 && theirEmail.split('@')[0] === local) reasons.push('same email name');
    if (handle.length >= 3 && theirHandle === handle) reasons.push('same Discord name');
    if (surname && theirs.length > 1 && theirs[theirs.length - 1] === surname) reasons.push('same surname');
    if (reasons.length > 0) out.push({ entry: row, reasons });
  }
  const weight = (r: string[]) => (r.includes('same Discord account') ? 3 : r.includes('same email') ? 2 : 0) + r.length;
  return out.sort((x, y) => weight(y.reasons) - weight(x.reasons)).slice(0, 5);
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
// The board asks for a correction: the entry stays where it is, and the
// note is the applicant's to read and answer by saving their details.
export async function askForCorrection(db: D1Database, id: number, note: string, by: string, now: number): Promise<RegisterRow | null> {
  const text = note.trim().slice(0, 400);
  if (!text) throw new RuleError('bad_input', 'Say what needs fixing.');
  await db
    .prepare('UPDATE register SET fix_note = ?2, fix_asked_at = ?3, fix_asked_by = ?4, updated_at = ?3 WHERE id = ?1')
    .bind(id, text, now, by)
    .run();
  return getRegisterEntry(db, id);
}

// Answered, or withdrawn by the board.
export async function clearCorrection(db: D1Database, id: number, now: number): Promise<void> {
  await db
    .prepare('UPDATE register SET fix_note = NULL, fix_asked_at = NULL, fix_asked_by = NULL, updated_at = ?2 WHERE id = ?1')
    .bind(id, now)
    .run();
}

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
         fix_note = NULL, fix_asked_at = NULL, fix_asked_by = NULL,
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

// The actives list as a board page shows it: who is one, who is waiting,
// and nothing else about them. The full rows are the register's personal
// data and stay behind the Google gate; a name, a handle to reach someone
// by and a date are what the board channel already says out loud, so this
// is what the wider board sees.
export interface ActiveBrief {
  id: number;
  full_name: string;
  telegram: string | null;
  discord_id: string | null;
  discord_name: string | null;
  active_since: number | null;
  asked_at: number; // when the request last moved: the entry's updated_at
}

const ACTIVE_BRIEF_COLUMNS =
  'id, full_name, telegram, discord_id, discord_name, active_since, updated_at AS asked_at';

export async function listActivesBrief(
  db: D1Database,
): Promise<{ actives: ActiveBrief[]; waiting: ActiveBrief[] }> {
  const [approved, asked] = await db.batch<ActiveBrief>([
    db.prepare(
      `SELECT ${ACTIVE_BRIEF_COLUMNS} FROM register
       WHERE status = 'member' AND is_active = 1
       ORDER BY full_name COLLATE NOCASE ASC`,
    ),
    db.prepare(
      `SELECT ${ACTIVE_BRIEF_COLUMNS} FROM register
       WHERE status = 'member' AND wants_active = 1 AND is_active = 0
       ORDER BY updated_at ASC`,
    ),
  ]);
  return { actives: approved.results, waiting: asked.results };
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
  await db.prepare('DELETE FROM tick_claims WHERE register_id = ?1').bind(id).run();
  await db.prepare('DELETE FROM ticks WHERE register_id = ?1').bind(id).run();
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

// --- the waitlist ------------------------------------------------------------------
// For a full solo event with a capacity and no tickets: first come, first
// promoted when a seat frees. Team events count teams, ticketed events
// sell seats, so neither has one.

export interface WaitlistRow {
  discord_id: string;
  username: string;
  avatar_hash: string | null;
  created_at: number;
}

async function waitlistEvent(db: D1Database, eventId: number): Promise<EventWithCounts> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  if (event.team_size !== null || event.capacity === null || (await isTicketed(db, eventId))) {
    throw new RuleError('no_waitlist', 'This event has no waitlist.');
  }
  return event;
}

async function seatsFree(db: D1Database, event: Pick<EventWithCounts, 'id' | 'capacity' | 'yes_count'>): Promise<number> {
  if (event.capacity === null) return Number.POSITIVE_INFINITY;
  const going = await db.prepare(`SELECT COUNT(*) AS n FROM signups WHERE event_id = ?1 AND status = 'yes'`).bind(event.id).first<{ n: number }>();
  return event.capacity - (going?.n ?? 0);
}

export async function joinWaitlist(db: D1Database, eventId: number, discordId: string, now: number): Promise<void> {
  const event = await waitlistEvent(db, eventId);
  if (event.cancelled_at !== null) throw new RuleError('cancelled', 'This event is cancelled.');
  if (event.published_at === null) throw new RuleError('closed', 'This event is not published yet.');
  if (!signupsOpen(event, now)) throw new RuleError('not_open', 'Signups are not open yet.');
  if (event.signups_closed_at !== null) throw new RuleError('closed', 'Signups are closed.');
  const mine = await db.prepare('SELECT status FROM signups WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, discordId).first<{ status: string }>();
  if (mine?.status === 'yes') throw new RuleError('duplicate', 'You are already going.');
  await requireEligible(db, event, discordId, true);
  if ((await seatsFree(db, event)) > 0) throw new RuleError('not_full', 'There is a seat free: sign up instead.');
  await db
    .prepare('INSERT OR IGNORE INTO event_waitlist (event_id, discord_id, created_at) VALUES (?1, ?2, ?3)')
    .bind(eventId, discordId, now)
    .run();
}

export async function leaveWaitlist(db: D1Database, eventId: number, discordId: string): Promise<void> {
  await db.prepare('DELETE FROM event_waitlist WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, discordId).run();
}

export async function listWaitlist(db: D1Database, eventId: number): Promise<WaitlistRow[]> {
  const { results } = await db
    .prepare(
      `SELECT w.discord_id, m.username, m.avatar_hash, w.created_at FROM event_waitlist w JOIN members m ON m.discord_id = w.discord_id
       WHERE w.event_id = ?1 ORDER BY w.created_at, w.discord_id`,
    )
    .bind(eventId)
    .all<WaitlistRow>();
  return results;
}

// 1-based place in the queue, or null when not on it.
export async function waitlistPosition(db: D1Database, eventId: number, discordId: string): Promise<number | null> {
  const rows = await listWaitlist(db, eventId);
  const at = rows.findIndex((r) => r.discord_id === discordId);
  return at === -1 ? null : at + 1;
}

// The board lets one person in from the waitlist, whatever their place
// and the capacity: a Going signup, and a promotion to tell them about.
export async function admitFromWaitlist(db: D1Database, eventId: number, discordId: string, now: number): Promise<void> {
  const waiting = await db.prepare('SELECT 1 AS x FROM event_waitlist WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, discordId).first();
  if (!waiting) throw new RuleError('missing', 'That person is not on the waitlist.');
  await db.batch([
    db.prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id) VALUES (?1, ?2, 'yes', ?3, NULL)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = 'yes', event_team_id = NULL`,
    ).bind(eventId, discordId, now),
    db.prepare('DELETE FROM event_waitlist WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, discordId),
    db.prepare('INSERT INTO waitlist_promotions (event_id, discord_id, promoted_at) VALUES (?1, ?2, ?3)').bind(eventId, discordId, now),
  ]);
}

// A capacity lowered under the going count: the latest signups beyond it
// move to the waitlist, keeping their signup time so they head the queue.
// Team events count teams and ticketed events sell seats, so neither
// demotes anyone. Returns who was moved, newest first.
export async function demoteOverCapacity(db: D1Database, eventId: number): Promise<string[]> {
  const event = await getEvent(db, eventId);
  if (!event || event.capacity === null || event.team_size !== null || (await isTicketed(db, eventId))) return [];
  const { results: going } = await db
    .prepare(`SELECT discord_id, created_at FROM signups WHERE event_id = ?1 AND status = 'yes' ORDER BY created_at, discord_id`)
    .bind(eventId)
    .all<{ discord_id: string; created_at: number }>();
  const overflow = going.slice(event.capacity).reverse();
  for (const row of overflow) {
    await db.batch([
      db.prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, row.discord_id),
      db.prepare('INSERT OR IGNORE INTO event_waitlist (event_id, discord_id, created_at) VALUES (?1, ?2, ?3)').bind(eventId, row.discord_id, row.created_at),
    ]);
  }
  return overflow.map((r) => r.discord_id);
}

// Seats freed, people let in, first come first: each becomes a Going
// signup and a promotion to announce. Anyone no longer eligible (say,
// a member-only seat and their membership lapsed) is dropped from the
// queue instead. Returns who got in.
export async function promoteWaitlist(db: D1Database, eventId: number, now = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const event = await getEvent(db, eventId);
  if (!event || event.capacity === null || event.team_size !== null || event.cancelled_at !== null) return [];
  const queue = await listWaitlist(db, eventId);
  if (queue.length === 0) return [];
  const promoted: string[] = [];
  let free = await seatsFree(db, event);
  for (const row of queue) {
    if (free <= 0) break;
    try {
      await requireEligible(db, event, row.discord_id, true);
    } catch {
      await leaveWaitlist(db, eventId, row.discord_id);
      continue;
    }
    await db
      .prepare(
        `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id) VALUES (?1, ?2, 'yes', ?3, NULL)
         ON CONFLICT (event_id, discord_id) DO UPDATE SET status = 'yes', event_team_id = NULL`,
      )
      .bind(eventId, row.discord_id, now)
      .run();
    await leaveWaitlist(db, eventId, row.discord_id);
    await db.prepare('INSERT INTO waitlist_promotions (event_id, discord_id, promoted_at) VALUES (?1, ?2, ?3)').bind(eventId, row.discord_id, now).run();
    promoted.push(row.discord_id);
    free--;
  }
  return promoted;
}

export interface PromotionRow {
  id: number;
  event_id: number;
  discord_id: string;
  promoted_at: number;
}

export async function listUnannouncedPromotions(db: D1Database): Promise<PromotionRow[]> {
  const { results } = await db
    .prepare('SELECT id, event_id, discord_id, promoted_at FROM waitlist_promotions WHERE announced_at IS NULL ORDER BY id LIMIT 50')
    .all<PromotionRow>();
  return results;
}

export async function markPromotionsAnnounced(db: D1Database, ids: number[], now: number): Promise<void> {
  for (const id of ids) await db.prepare('UPDATE waitlist_promotions SET announced_at = ?2 WHERE id = ?1').bind(id, now).run();
}

// Events whose role is still out although they ended before `before`:
// the hourly job archives them (src/lib/cron.ts).
export async function listEndedEventsWithRole(db: D1Database, before: number): Promise<EventWithCounts[]> {
  const { results } = await db
    .prepare(`${EVENT_COUNTS} WHERE e.discord_role_id IS NOT NULL AND COALESCE(e.ends_at, e.starts_at) < ?1 ORDER BY e.starts_at`)
    .bind(before)
    .all<EventWithCounts>();
  return results;
}

// --- event photos ---------------------------------------------------------------------
// Uploaded by the board, shrunk in the browser first: a picture of at most
// 1600 px and a thumbnail. Kept in D1 like the covers.

export const PHOTO_MAX_BYTES = 900_000;
export const PHOTOS_PER_EVENT = 60;

export interface EventPhotoRow {
  id: number;
  event_id: number;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  has_thumb: number;
  created_at: number;
}

export async function addEventPhoto(
  db: D1Database,
  eventId: number,
  contentType: string,
  bytes: ArrayBuffer,
  thumb: ArrayBuffer | null,
  now: number,
): Promise<number> {
  if (!(COVER_TYPES as readonly string[]).includes(contentType)) throw new RuleError('bad_input', 'JPEG, PNG or WebP only.');
  if (bytes.byteLength === 0 || bytes.byteLength > PHOTO_MAX_BYTES) throw new RuleError('bad_input', 'The picture is empty or too big; the page shrinks pictures before upload when JavaScript is on.');
  const size = imageSize(bytes);
  if (!size) throw new RuleError('bad_input', 'That file is not a readable image.');
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM event_photos WHERE event_id = ?1').bind(eventId).first<{ n: number }>();
  if ((count?.n ?? 0) >= PHOTOS_PER_EVENT) throw new RuleError('bad_input', `At most ${PHOTOS_PER_EVENT} photos per event.`);
  const row = await db
    .prepare(
      `INSERT INTO event_photos (event_id, content_type, bytes, thumb, size, width, height, sort, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING id`,
    )
    .bind(eventId, contentType, bytes, thumb, bytes.byteLength, size.width, size.height, now)
    .first<{ id: number }>();
  return row!.id;
}

export async function listEventPhotos(db: D1Database, eventId: number): Promise<EventPhotoRow[]> {
  const { results } = await db
    .prepare('SELECT id, event_id, content_type, size, width, height, (thumb IS NOT NULL) AS has_thumb, created_at FROM event_photos WHERE event_id = ?1 ORDER BY sort, id')
    .bind(eventId)
    .all<EventPhotoRow>();
  return results;
}

export async function getEventPhoto(db: D1Database, id: number, thumb: boolean): Promise<{ content_type: string; bytes: ArrayBuffer; created_at: number } | null> {
  const row = await db
    .prepare(`SELECT content_type, ${thumb ? 'COALESCE(thumb, bytes)' : 'bytes'} AS bytes, created_at FROM event_photos WHERE id = ?1`)
    .bind(id)
    .first<{ content_type: string; bytes: unknown; created_at: number }>();
  return row ? { content_type: thumb ? 'image/jpeg' : row.content_type, bytes: blobBytes(row.bytes), created_at: row.created_at } : null;
}

export async function deleteEventPhoto(db: D1Database, eventId: number, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM event_photos WHERE id = ?1 AND event_id = ?2').bind(id, eventId).run();
  return (result.meta.changes ?? 0) > 0;
}

export interface PhotoAlbum {
  event_id: number;
  title: string;
  starts_at: number;
  photos: number;
  first_id: number;
  photo_credit: string | null;
}

// Past events with photos, newest first, for the history page.
export async function listPhotoAlbums(db: D1Database, limit = 30): Promise<PhotoAlbum[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS event_id, e.title, e.starts_at, e.photo_credit, COUNT(p.id) AS photos,
              (SELECT p2.id FROM event_photos p2 WHERE p2.event_id = e.id ORDER BY p2.sort, p2.id LIMIT 1) AS first_id
       FROM events e JOIN event_photos p ON p.event_id = e.id
       WHERE e.cancelled_at IS NULL AND e.published_at IS NOT NULL
       GROUP BY e.id ORDER BY e.starts_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<PhotoAlbum>();
  return results;
}

// --- milestones -----------------------------------------------------------------------

export const EVENT_MILESTONES = [5, 10, 25, 50, 100];
export const WIN_MILESTONES = [1, 5, 10];

// True when this call recorded the milestone (so it is told once).
export async function recordMilestone(db: D1Database, discordId: string, kind: 'events' | 'wins', value: number, now: number): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO milestones (discord_id, kind, value, sent_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(discordId, kind, value, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Everyone who was at an event: going, or a paid ticket on their account.
export async function listAttendees(db: D1Database, eventId: number): Promise<{ discord_id: string; username: string; leaderboard: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT m.discord_id, m.username, (m.leaderboard_hidden = 0) AS leaderboard FROM members m
       WHERE EXISTS (SELECT 1 FROM signups s WHERE s.event_id = ?1 AND s.discord_id = m.discord_id AND s.status = 'yes')
          OR EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = ?1 AND t.discord_id = m.discord_id AND t.status = 'paid')`,
    )
    .bind(eventId)
    .all<{ discord_id: string; username: string; leaderboard: number }>();
  return results;
}

export async function countNewMembers(db: D1Database, since: number): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM register WHERE status = 'member' AND decided_at >= ?1`).bind(since).first<{ n: number }>();
  return row?.n ?? 0;
}

// Events that ended within a window, for the milestone check.
export async function listEventsEndedBetween(db: D1Database, from: number, to: number): Promise<EventWithCounts[]> {
  const { results } = await db
    .prepare(`${EVENT_COUNTS} WHERE e.cancelled_at IS NULL AND e.published_at IS NOT NULL AND COALESCE(e.ends_at, e.starts_at) > ?1 AND COALESCE(e.ends_at, e.starts_at) <= ?2`)
    .bind(from, to)
    .all<EventWithCounts>();
  return results;
}

// --- the leaderboard ----------------------------------------------------------------
// Public on the history page: events attended and tournament wins, from
// the same records as the stats card. Every member is on it unless they
// hide themselves on their membership page.

export interface LeaderboardRow {
  discord_id: string;
  username: string;
  avatar_hash: string | null;
  attended: number;
  wins: number;
}

// `on` = shown. Someone not in the members table yet is shown once they are.
export async function setLeaderboardOptIn(db: D1Database, discordId: string, on: boolean): Promise<void> {
  await db.prepare('UPDATE members SET leaderboard_hidden = ?2 WHERE discord_id = ?1').bind(discordId, on ? 0 : 1).run();
}

export async function isLeaderboardOptIn(db: D1Database, discordId: string): Promise<boolean> {
  const row = await db.prepare('SELECT leaderboard_hidden FROM members WHERE discord_id = ?1').bind(discordId).first<{ leaderboard_hidden: number }>();
  return row ? row.leaderboard_hidden === 0 : true;
}

export async function leaderboard(db: D1Database, now: number, limit = 10): Promise<{ events: LeaderboardRow[]; wins: LeaderboardRow[] }> {
  const { results } = await db
    .prepare(
      `SELECT m.discord_id, m.username, m.avatar_hash,
         (SELECT COUNT(DISTINCT e.id) FROM events e
          WHERE e.cancelled_at IS NULL AND e.published_at IS NOT NULL
            AND (e.starts_at < ?1 OR EXISTS (SELECT 1 FROM bracket_matches b WHERE b.event_id = e.id AND b.winner IS NOT NULL AND b.round = (SELECT MAX(round) FROM bracket_matches b2 WHERE b2.bracket_id = b.bracket_id)))
            AND (EXISTS (SELECT 1 FROM signups s WHERE s.event_id = e.id AND s.discord_id = m.discord_id AND s.status = 'yes')
              OR EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.discord_id = m.discord_id AND t.status = 'paid'))) AS attended
       FROM members m WHERE m.leaderboard_hidden = 0`,
    )
    .bind(now)
    .all<Omit<LeaderboardRow, 'wins'>>();
  const winCount = new Map<string, number>();
  for (const result of await listResults(db, 1000)) {
    for (const who of result.avatars) winCount.set(who.discord_id, (winCount.get(who.discord_id) ?? 0) + 1);
  }
  const rows: LeaderboardRow[] = results.map((r) => ({ ...r, wins: winCount.get(r.discord_id) ?? 0 }));
  return {
    events: rows.filter((r) => r.attended > 0).sort((a, b) => b.attended - a.attended || a.username.localeCompare(b.username)).slice(0, limit),
    wins: rows.filter((r) => r.wins > 0).sort((a, b) => b.wins - a.wins || a.username.localeCompare(b.username)).slice(0, limit),
  };
}

// --- team captains ----------------------------------------------------------------
// Whoever founded a team runs it while signups are open: adding someone
// who is on the roster without a team, and taking a member out. The
// board's roster tools do the rest.

async function captainTeam(db: D1Database, eventId: number, teamId: number, captainId: string, now: number): Promise<EventWithCounts> {
  const event = await requireOpenTeamEvent(db, eventId, now);
  const team = await db.prepare('SELECT created_by FROM event_teams WHERE id = ?1 AND event_id = ?2').bind(teamId, eventId).first<{ created_by: string }>();
  if (!team) throw new RuleError('missing', 'No such team on this event.');
  if (team.created_by !== captainId) throw new RuleError('not_captain', 'Only the team founder can do that.');
  return event;
}

export async function captainAddToTeam(db: D1Database, eventId: number, teamId: number, captainId: string, targetId: string, now: number): Promise<void> {
  const event = await captainTeam(db, eventId, teamId, captainId, now);
  const target = await db.prepare('SELECT event_team_id FROM signups WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, targetId).first<{ event_team_id: number | null }>();
  if (!target) throw new RuleError('missing', 'That person is not signed up for this event.');
  if (target.event_team_id !== null) throw new RuleError('bad_input', 'That person is already in a team.');
  const bench = await placeInTeam(db, event, teamId, null);
  await db.prepare("UPDATE signups SET event_team_id = ?3, status = 'yes', reserve = ?4 WHERE event_id = ?1 AND discord_id = ?2").bind(eventId, targetId, teamId, bench).run();
}

// Swapping the bench for the line-up and back, which is what a reserve is
// for. The captain does it for their own team while signups are open; the
// board does it whenever, through the roster.
export async function captainSetTeamPlace(db: D1Database, eventId: number, teamId: number, captainId: string, targetId: string, reserve: boolean, now: number): Promise<void> {
  const event = await captainTeam(db, eventId, teamId, captainId, now);
  const inTeam = await db.prepare('SELECT reserve FROM signups WHERE event_id = ?1 AND discord_id = ?2 AND event_team_id = ?3').bind(eventId, targetId, teamId).first<{ reserve: number }>();
  if (!inTeam) throw new RuleError('missing', 'That person is not in this team.');
  if ((inTeam.reserve === 1) === reserve) return;
  const bench = await placeInTeam(db, event, teamId, targetId, reserve);
  await db.prepare('UPDATE signups SET reserve = ?3 WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, targetId, bench).run();
}

// The same swap from the board's side, on any team, signups open or not.
export async function setTeamPlace(db: D1Database, eventId: number, discordId: string, reserve: boolean): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const row = await db.prepare('SELECT event_team_id, reserve FROM signups WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, discordId).first<{ event_team_id: number | null; reserve: number }>();
  if (!row?.event_team_id) throw new RuleError('missing', 'That person is not in a team on this event.');
  if ((row.reserve === 1) === reserve) return;
  const bench = await placeInTeam(db, event, row.event_team_id, discordId, reserve);
  await db.prepare('UPDATE signups SET reserve = ?3 WHERE event_id = ?1 AND discord_id = ?2').bind(eventId, discordId, bench).run();
}

export async function captainRemoveFromTeam(db: D1Database, eventId: number, teamId: number, captainId: string, targetId: string, now: number): Promise<void> {
  await captainTeam(db, eventId, teamId, captainId, now);
  if (targetId === captainId) throw new RuleError('bad_input', 'Leave the team instead.');
  const result = await db
    .prepare('UPDATE signups SET event_team_id = NULL WHERE event_id = ?1 AND discord_id = ?2 AND event_team_id = ?3')
    .bind(eventId, targetId, teamId)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new RuleError('missing', 'That person is not in this team.');
}

// --- a member's stats ---------------------------------------------------------------
// From what is already recorded: events attended (going, or a paid
// ticket, on past events, or on any event whose final is decided),
// tournaments played and won (the bracket, as a player or in a team),
// and since when they are a member.

export interface MemberStats {
  attended: number;
  tournaments: number;
  wins: number;
  first_event_at: number | null;
  last_win: { title: string; starts_at: number } | null;
  member_since: number | null; // the register's decision date for a current member
}

export async function memberStats(db: D1Database, discordId: string, now: number): Promise<MemberStats> {
  const { results: attended } = await db
    .prepare(
      `SELECT e.id, e.title, e.starts_at, e.team_size,
         (SELECT s.event_team_id FROM signups s WHERE s.event_id = e.id AND s.discord_id = ?1) AS team_id
       FROM events e
       WHERE e.cancelled_at IS NULL AND e.published_at IS NOT NULL
         AND (e.starts_at < ?2 OR EXISTS (SELECT 1 FROM bracket_matches b WHERE b.event_id = e.id AND b.winner IS NOT NULL AND b.round = (SELECT MAX(round) FROM bracket_matches b2 WHERE b2.bracket_id = b.bracket_id)))
         AND (EXISTS (SELECT 1 FROM signups s WHERE s.event_id = e.id AND s.discord_id = ?1 AND s.status = 'yes')
           OR EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.discord_id = ?1 AND t.status = 'paid'))
       ORDER BY e.starts_at`,
    )
    .bind(discordId, now)
    .all<{ id: number; title: string; starts_at: number; team_size: number | null; team_id: number | null }>();
  let tournaments = 0;
  let wins = 0;
  let lastWin: MemberStats['last_win'] = null;
  // An event they were drawn into is one tournament played, however many
  // brackets it ran; each of those brackets is a trophy of its own.
  for (const event of attended) {
    const key = event.team_id !== null ? `t:${event.team_id}` : `u:${discordId}`;
    let played = false;
    for (const bracket of await listBrackets(db, event.id)) {
      const matches = await getBracket(db, bracket.id);
      if (!matches.some((m) => m.side_a === key || m.side_b === key)) continue;
      played = true;
      const total = matches.reduce((max, m) => Math.max(max, m.round), 0);
      const final = matches.find((m) => m.round === total && m.slot === 0);
      if (final?.winner === key) {
        wins++;
        lastWin = { title: event.title, starts_at: event.starts_at };
      }
    }
    if (played) tournaments++;
  }
  const entry = await getRegisterByDiscord(db, discordId);
  return {
    attended: attended.length,
    tournaments,
    wins,
    first_event_at: attended[0]?.starts_at ?? null,
    last_win: lastWin,
    member_since: entry?.status === 'member' ? (entry.decided_at ?? entry.applied_at) : null,
  };
}

// --- duplicate an event ---------------------------------------------------------------

// A new draft with the same setup: details, ticket types (sales
// deadlines dropped), questions and the cover, a week later. Not the
// roster, not the Discord objects, not the bracket.
export async function duplicateEvent(db: D1Database, id: number, by: string, now: number): Promise<number> {
  const source = await getEvent(db, id);
  if (!source) throw new RuleError('missing', `No event with id ${id}.`);
  const shift = 7 * 86400;
  const copy = await createEvent(
    db,
    {
      title: `${source.title} (copy)`.slice(0, 120),
      description: source.description,
      starts_at: source.starts_at + shift,
      ends_at: source.ends_at === null ? null : source.ends_at + shift,
      capacity: source.capacity,
      team_size: source.team_size,
      team_reserves: source.team_reserves,
      organizers: source.organizers,
      location: source.location,
      link_url: source.link_url,
      members_only: source.members_only === 1,
      member_slots: source.member_slots,
      created_by: by,
      published: false,
    },
    now,
  );
  for (const type of await listTicketTypes(db, id)) {
    if (type.active !== 1) continue;
    await createTicketType(db, copy, {
      name: type.name,
      price_cents: type.price_cents,
      member_price_cents: type.member_price_cents,
      members_only: type.members_only === 1,
      quantity: type.quantity,
      sales_close_at: null,
      description: type.description,
    });
  }
  for (const q of await listEventQuestions(db, id)) {
    await createEventQuestion(db, copy, { label: q.label, kind: q.kind, options: q.options, required: q.required === 1 });
  }
  const cover = await getEventCover(db, id);
  if (cover && cover.bytes.byteLength > 0) await setEventCover(db, copy, cover.content_type, cover.bytes, now);
  return copy;
}

// --- my events ---------------------------------------------------------------------

export type MyEventRelation = 'ticket' | 'going' | 'maybe' | 'waitlist' | 'interested';
export interface MyEventRow extends EventRow {
  relation: MyEventRelation;
}

// Everything upcoming a person has a stake in, strongest stake first:
// a paid ticket, going, maybe, on the waitlist, or just interested.
export async function listMyEvents(db: D1Database, discordId: string, now: number): Promise<MyEventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.*,
         CASE
           WHEN EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.discord_id = ?1 AND t.status = 'paid') THEN 'ticket'
           WHEN s.status = 'yes' THEN 'going'
           WHEN s.status = 'maybe' THEN 'maybe'
           WHEN EXISTS (SELECT 1 FROM event_waitlist w WHERE w.event_id = e.id AND w.discord_id = ?1) THEN 'waitlist'
           ELSE 'interested'
         END AS relation
       FROM events e
       LEFT JOIN signups s ON s.event_id = e.id AND s.discord_id = ?1
       WHERE e.published_at IS NOT NULL AND e.cancelled_at IS NULL AND COALESCE(e.ends_at, e.starts_at) >= ?2
         AND (s.discord_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM event_waitlist w WHERE w.event_id = e.id AND w.discord_id = ?1)
           OR EXISTS (SELECT 1 FROM event_interest i WHERE i.event_id = e.id AND i.discord_id = ?1)
           OR EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.discord_id = ?1 AND t.status = 'paid'))
       ORDER BY e.starts_at`,
    )
    .bind(discordId, now)
    .all<MyEventRow>();
  return results;
}

// --- signups open at, and the Interested heart --------------------------------------

export async function setSignupsOpenAt(db: D1Database, eventId: number, at: number | null): Promise<void> {
  await db.prepare('UPDATE events SET signups_open_at = ?2 WHERE id = ?1').bind(eventId, at).run();
}

export async function setSignupsCloseAt(db: D1Database, eventId: number, at: number | null): Promise<void> {
  await db.prepare('UPDATE events SET signups_close_at = ?2 WHERE id = ?1').bind(eventId, at).run();
}

export interface InterestRow {
  discord_id: string;
  source: 'site' | 'discord';
}

export async function listInterest(db: D1Database, eventId: number): Promise<InterestRow[]> {
  const { results } = await db.prepare('SELECT discord_id, source FROM event_interest WHERE event_id = ?1 ORDER BY created_at').bind(eventId).all<InterestRow>();
  return results;
}

export async function isInterested(db: D1Database, eventId: number, discordId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM event_interest WHERE event_id = ?1 AND discord_id = ?2 LIMIT 1').bind(eventId, discordId).first();
  return row !== null;
}

// The site's heart: on, off, on. True when it is on afterwards. Interest
// marked on Discord is Discord's to remove and stays counted.
export async function toggleInterest(db: D1Database, eventId: number, discordId: string, now: number): Promise<boolean> {
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  const mine = await db.prepare("SELECT 1 AS x FROM event_interest WHERE event_id = ?1 AND discord_id = ?2 AND source = 'site'").bind(eventId, discordId).first();
  if (mine) {
    await db.prepare("DELETE FROM event_interest WHERE event_id = ?1 AND discord_id = ?2 AND source = 'site'").bind(eventId, discordId).run();
    return false;
  }
  await db.prepare("INSERT INTO event_interest (event_id, discord_id, source, created_at) VALUES (?1, ?2, 'site', ?3)").bind(eventId, discordId, now).run();
  return true;
}

// Discord's Interested list, as last read: replaced whole.
export async function replaceDiscordInterest(db: D1Database, eventId: number, discordIds: string[], now: number): Promise<void> {
  const statements = [db.prepare("DELETE FROM event_interest WHERE event_id = ?1 AND source = 'discord'").bind(eventId)];
  for (const id of new Set(discordIds)) {
    statements.push(db.prepare("INSERT OR IGNORE INTO event_interest (event_id, discord_id, source, created_at) VALUES (?1, ?2, 'discord', ?3)").bind(eventId, id, now));
  }
  statements.push(db.prepare('UPDATE events SET interest_synced_at = ?2 WHERE id = ?1').bind(eventId, now));
  await db.batch(statements);
}

// --- settings ------------------------------------------------------------------
// Board-editable configuration (migration 0010). Keys live here so a typo
// cannot invent one.

export type SettingKey = 'member_role_id' | 'actives_role_id' | 'event_category_id' | 'champion_role_id' | 'participant_role_id' | 'champion_holders' | 'announce_channel_id' | 'board_channel_id' | 'digest_sent_at' | 'activity_channels' | 'event_ping_roles';

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

// Reserved seats only mean something inside a capacity: an event with no
// capacity keeps no reservation, whatever the field says.
// Places on the bench, per team. Nought is the ordinary tournament: the
// team that signs up is the team that plays.
function checkReserves(reserves: number): number {
  if (!Number.isInteger(reserves) || reserves < 0 || reserves > 20) {
    throw new RuleError('bad_input', 'Reserves per team is a whole number from 0 to 20.');
  }
  return reserves;
}

// Reserved seats are counted in people on every event. A team event's
// capacity is in teams, so the places it has are the line-ups those
// teams field — four teams of two is eight places, of which the board
// may hold any number for members.
export function eventPlaces(capacity: number | null, teamSize: number | null): number | null {
  return capacity === null ? null : capacity * (teamSize ?? 1);
}

function checkMemberSlots(slots: number | null, capacity: number | null, teamSize: number | null): number | null {
  if (slots === null || capacity === null) return null;
  if (!Number.isInteger(slots) || slots < 1) throw new RuleError('bad_input', 'Reserved seats must be a positive whole number.');
  if (slots > eventPlaces(capacity, teamSize)!) throw new RuleError('bad_input', 'Reserved seats cannot exceed the places the event has.');
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
  now = Math.floor(Date.now() / 1000),
): Promise<SeatAccess> {
  const member = discordId ? await isCurrentMember(db, discordId) : false;
  if (event.members_only === 1 && !member) {
    return { allowed: false, reason: 'members_only', member, openSeatsLeft: null };
  }
  const places = eventPlaces(event.capacity, event.team_size);
  if (event.member_slots === null || places === null) return { allowed: true, reason: null, member, openSeatsLeft: null };
  const nonMembers = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM signups s
       WHERE s.event_id = ?1 AND s.status = 'yes' AND s.discord_id != ?2
         AND NOT EXISTS (SELECT 1 FROM register r WHERE r.discord_id = s.discord_id AND r.status = 'member')`,
    )
    .bind(event.id, discordId ?? '')
    .first<{ n: number }>();
  // Tickets by name (no Discord account) never become signups; they are
  // non-member seats all the same.
  const byName = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets WHERE event_id = ?1 AND discord_id IS NULL
         AND (status = 'paid' OR (status = 'pending' AND created_at > ?2))`,
    )
    .bind(event.id, now - PENDING_TICKET_SECONDS)
    .first<{ n: number }>();
  const openSeatsLeft = Math.max(0, places - event.member_slots - (nonMembers?.n ?? 0) - (byName?.n ?? 0));
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
  const full = await getEvent(db, event.id);
  if (full && full.published_at === null) throw new RuleError('closed', 'This event is not published yet.');
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
  description: string; // what the ticket includes, shown under its name
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
  checkout_url: string | null;
  created_at: number;
  paid_at: number | null;
  checked_in_at: number | null;
  checked_in_by: string | null;
  bought_by: string | null; // a signed-in buyer's Discord id on a ticket bought for someone else
  purchase_id: string | null; // tickets bought together
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
  description?: string;
}): void {
  const name = input.name.trim();
  if (!name || name.length > 60) throw new RuleError('bad_input', 'A ticket type name is 1 to 60 characters.');
  if ((input.description ?? '').length > 300) throw new RuleError('bad_input', 'A ticket description is at most 300 characters.');
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
    description?: string;
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
      `INSERT INTO ticket_types (event_id, name, price_cents, member_price_cents, members_only, quantity, sales_close_at, sort, description)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id`,
    )
    .bind(eventId, input.name.trim(), input.price_cents, input.member_price_cents, input.members_only ? 1 : 0, input.quantity, input.sales_close_at, (last?.s ?? 0) + 1, (input.description ?? '').trim())
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
    description?: string;
  },
): Promise<void> {
  const type = await getTicketType(db, id);
  if (!type) throw new RuleError('missing', 'No such ticket type.');
  checkTicketTypeInput(input);
  await db
    .prepare(
      `UPDATE ticket_types SET name = ?2, price_cents = ?3, member_price_cents = ?4, members_only = ?5,
         quantity = ?6, sales_close_at = ?7, active = ?8, description = ?9 WHERE id = ?1`,
    )
    .bind(id, input.name.trim(), input.price_cents, input.member_price_cents, input.members_only ? 1 : 0, input.quantity, input.sales_close_at, input.active ? 1 : 0, (input.description ?? '').trim())
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
  if (event.published_at === null) return { ok: false, reason: 'sales_closed' };
  if (!signupsOpen(event, now)) return { ok: false, reason: 'not_open' };
  if (type.active !== 1) return { ok: false, reason: 'sales_closed' };
  const closes = type.sales_close_at ?? event.starts_at;
  if (now >= closes) return { ok: false, reason: 'sales_closed' };
  if (type.quantity !== null && type.sold >= type.quantity) return { ok: false, reason: 'sold_out' };
  const access = await signupAccess(db, event, discordId, true, now);
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

export async function countLiveTickets(db: D1Database, eventId: number, now: number): Promise<number> {
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
    bought_by?: string | null;
    purchase_id?: string | null;
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
             stripe_session_id, stripe_payment_intent, created_at, paid_at, bought_by, purchase_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) RETURNING *`,
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
          input.bought_by ?? null,
          input.purchase_id ?? null,
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

export async function ensureYesSignup(db: D1Database, eventId: number, discordId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id)
       VALUES (?1, ?2, 'yes', ?3, NULL)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET status = 'yes'`,
    )
    .bind(eventId, discordId, now)
    .run();
}

// --- cover images -------------------------------------------------------------------

export const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const COVER_MAX_BYTES = 1_500_000;

// The cover's version (its upload time) for the image URL, and its pixel
// size so the page reserves a box of the right shape.
export interface CoverInfo {
  updated_at: number;
  width: number;
  height: number;
}

export async function coverInfo(db: D1Database, eventId: number): Promise<CoverInfo | null> {
  const row = await db
    .prepare('SELECT updated_at, width, height FROM event_covers WHERE event_id = ?1')
    .bind(eventId)
    .first<{ updated_at: number; width: number | null; height: number | null }>();
  if (!row) return null;
  return { updated_at: row.updated_at, width: row.width ?? 1200, height: row.height ?? 630 };
}

// Versions for a whole list (the events page tiles).
export async function coverVersions(db: D1Database, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(`SELECT event_id, updated_at FROM event_covers WHERE event_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})`)
    .bind(...ids)
    .all<{ event_id: number; updated_at: number }>();
  for (const row of results) out.set(row.event_id, row.updated_at);
  return out;
}

export async function coverVersion(db: D1Database, eventId: number): Promise<number | null> {
  return (await coverInfo(db, eventId))?.updated_at ?? null;
}

// D1 hands a BLOB back as an ArrayBuffer locally and as a plain array of
// bytes over its JSON transport in production; both become one ArrayBuffer.
export function blobBytes(value: unknown): ArrayBuffer {
  let view: Uint8Array;
  if (value instanceof ArrayBuffer) return value;
  else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (Array.isArray(value)) view = Uint8Array.from(value as number[]);
  else if (value && typeof value === 'object') view = Uint8Array.from(Object.values(value as Record<string, number>));
  else view = new Uint8Array();
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

export async function getEventCover(db: D1Database, eventId: number): Promise<{ content_type: string; bytes: ArrayBuffer; updated_at: number } | null> {
  const row = await db
    .prepare('SELECT content_type, bytes, updated_at FROM event_covers WHERE event_id = ?1')
    .bind(eventId)
    .first<{ content_type: string; bytes: unknown; updated_at: number }>();
  return row ? { content_type: row.content_type, bytes: blobBytes(row.bytes), updated_at: row.updated_at } : null;
}

export async function setEventCover(db: D1Database, eventId: number, contentType: string, bytes: ArrayBuffer, now: number): Promise<void> {
  if (!(COVER_TYPES as readonly string[]).includes(contentType)) throw new RuleError('bad_input', 'JPEG, PNG or WebP only.');
  if (bytes.byteLength === 0 || bytes.byteLength > COVER_MAX_BYTES) throw new RuleError('bad_input', 'The image is empty or over 1.5 MB.');
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1) throw new RuleError('bad_input', 'That file is not a readable image.');
  const event = await getEvent(db, eventId);
  if (!event) throw new RuleError('missing', `No event with id ${eventId}.`);
  await db
    .prepare(
      `INSERT INTO event_covers (event_id, content_type, bytes, size, updated_at, width, height) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (event_id) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes, size = excluded.size,
         updated_at = excluded.updated_at, width = excluded.width, height = excluded.height`,
    )
    .bind(eventId, contentType, bytes, bytes.byteLength, now, size.width, size.height)
    .run();
}

export async function deleteEventCover(db: D1Database, eventId: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM event_covers WHERE event_id = ?1').bind(eventId).run();
  return (result.meta.changes ?? 0) > 0;
}

// --- news covers --------------------------------------------------------------------
// A picture on a news post: on the news page and attached to the Discord
// post. Same file rules as the event covers.

export async function getAnnouncementCover(db: D1Database, id: number): Promise<{ content_type: string; bytes: ArrayBuffer; updated_at: number } | null> {
  const row = await db
    .prepare('SELECT content_type, bytes, updated_at FROM announcement_covers WHERE announcement_id = ?1')
    .bind(id)
    .first<{ content_type: string; bytes: unknown; updated_at: number }>();
  return row ? { content_type: row.content_type, bytes: blobBytes(row.bytes), updated_at: row.updated_at } : null;
}

export async function setAnnouncementCover(db: D1Database, id: number, contentType: string, bytes: ArrayBuffer, now: number): Promise<void> {
  if (!(COVER_TYPES as readonly string[]).includes(contentType)) throw new RuleError('bad_input', 'JPEG, PNG or WebP only.');
  if (bytes.byteLength === 0 || bytes.byteLength > COVER_MAX_BYTES) throw new RuleError('bad_input', 'The image is empty or over 1.5 MB.');
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1) throw new RuleError('bad_input', 'That file is not a readable image.');
  if (!(await getAnnouncement(db, id))) throw new RuleError('missing', `No post with id ${id}.`);
  await db
    .prepare(
      `INSERT INTO announcement_covers (announcement_id, content_type, bytes, size, updated_at, width, height) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (announcement_id) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes, size = excluded.size,
         updated_at = excluded.updated_at, width = excluded.width, height = excluded.height`,
    )
    .bind(id, contentType, bytes, bytes.byteLength, now, size.width, size.height)
    .run();
}

export async function deleteAnnouncementCover(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM announcement_covers WHERE announcement_id = ?1').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// Every paid ticket on a linked account is a 'yes' signup; put back any
// that went missing (an admin removal from before that was forbidden).
export async function repairTicketSignups(db: D1Database, eventId: number, now: number): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id)
       SELECT k.event_id, k.discord_id, 'yes', ?2, NULL FROM tickets k
        WHERE k.event_id = ?1 AND k.status = 'paid' AND k.discord_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM signups s WHERE s.event_id = k.event_id AND s.discord_id = k.discord_id)`,
    )
    .bind(eventId, now)
    .run();
  return result.meta.changes ?? 0;
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
    .prepare(
      `${TICKET_SELECT} WHERE (k.discord_id = ?1 OR k.bought_by = ?1) AND k.status IN ('paid','pending')
         ORDER BY e.starts_at DESC, k.discord_id IS NULL, k.id`,
    )
    .bind(discordId)
    .all<TicketWithType>();
  return results;
}

export async function listTicketsBySession(db: D1Database, sessionId: string): Promise<TicketRow[]> {
  const { results } = await db.prepare('SELECT * FROM tickets WHERE stripe_session_id = ?1 ORDER BY id').bind(sessionId).all<TicketRow>();
  return results;
}

export async function listTicketsByPurchase(db: D1Database, purchaseId: string): Promise<TicketWithType[]> {
  const { results } = await db.prepare(`${TICKET_SELECT} WHERE k.purchase_id = ?1 ORDER BY k.id`).bind(purchaseId).all<TicketWithType>();
  return results;
}

export async function listTicketsByPaymentIntent(db: D1Database, paymentIntent: string): Promise<TicketRow[]> {
  const { results } = await db.prepare('SELECT * FROM tickets WHERE stripe_payment_intent = ?1 ORDER BY id').bind(paymentIntent).all<TicketRow>();
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

export async function setTicketCheckout(db: D1Database, ticketId: number, sessionId: string, url: string): Promise<void> {
  await db.prepare('UPDATE tickets SET stripe_session_id = ?2, checkout_url = ?3 WHERE id = ?1').bind(ticketId, sessionId, url).run();
}

// A pending ticket whose Checkout page is still open: the buyer can go
// back to it instead of starting over.
export function resumableCheckout(ticket: TicketRow | null, now: number): string | null {
  if (!ticket || ticket.status !== 'pending' || !ticket.checkout_url) return null;
  return ticket.created_at > now - PENDING_TICKET_SECONDS ? ticket.checkout_url : null;
}

// Only a pending ticket can be voided; true when this call did it.
export async function voidTicket(db: D1Database, ticketId: number): Promise<boolean> {
  const result = await db.prepare("UPDATE tickets SET status = 'void' WHERE id = ?1 AND status = 'pending'").bind(ticketId).run();
  return (result.meta.changes ?? 0) > 0;
}

// A refund (from Stripe's dashboard, reported by the webhook, or a comp
// ticket withdrawn by the board): the ticket is dead and the seat freed.
export async function refundTicket(db: D1Database, ticketId: number): Promise<TicketRow | null> {
  const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ?1').bind(ticketId).first<TicketRow>();
  if (!ticket || ticket.status === 'refunded') return ticket;
  await db.prepare("UPDATE tickets SET status = 'refunded' WHERE id = ?1").bind(ticketId).run();
  if (ticket.discord_id) {
    const wasIn = await teamOf(db, ticket.event_id, ticket.discord_id);
    await db.prepare('DELETE FROM signups WHERE event_id = ?1 AND discord_id = ?2').bind(ticket.event_id, ticket.discord_id).run();
    await dropTeamIfEmpty(db, ticket.event_id, wasIn);
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
export async function recordDoorPayment(db: D1Database, paymentIntent: string, amountCents: number, now: number, note: string | null = null): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO door_payments (stripe_payment_intent, amount_cents, created_at, note) VALUES (?1, ?2, ?3, ?4)')
    .bind(paymentIntent, amountCents, now, note ? note.replace(/\s+/g, ' ').trim().slice(0, 80) || null : null)
    .run();
}

export interface DoorPaymentRow {
  stripe_payment_intent: string;
  amount_cents: number;
  created_at: number;
  ticket_id: number | null;
  purchase_id: string | null; // set when the payment bought a shop item instead
  note: string | null; // the description typed in the Stripe app
}

export async function listUnattachedDoorPayments(db: D1Database, since: number): Promise<DoorPaymentRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM door_payments WHERE ticket_id IS NULL AND purchase_id IS NULL AND created_at >= ?1 ORDER BY created_at DESC')
    .bind(since)
    .all<DoorPaymentRow>();
  return results;
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

