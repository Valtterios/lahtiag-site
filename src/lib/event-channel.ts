// The tournament talks in its own channel: every move the board makes on
// an event (signups closed, bracket out, a result, a revert, the champion,
// a screen message, a cancellation, a new time or place) is also posted by
// the bot into the event's discussion channel, when it has one. The lines
// are built here, pure, so both the site's routes and the Discord panel
// say the same thing; posting is best effort and never blocks a response.

import type { D1Database } from '@cloudflare/workers-types';
import { getEvent, getBracket, listSignups, listEventTeams, listUnannouncedPromotions, markPromotionsAnnounced, memberStats, getSettings, setSetting, getEventPhoto, recordMilestone, WIN_MILESTONES, type BracketMatch, type EventRow } from './db';
import { formatHelsinkiRange } from './time';
import { profileCardPng } from './profile-card';
import { syncEventRole } from './event-discord';
import { setGuildMemberRole, postWebhookWithFile, dmUser, postWebhook } from './discord';
import { DISCORD_GUILD_ID } from './config';
import {
  postChannelMessage,
  createChannelMessage,
  createChannelMessageWithFile,
  editChannelMessage,
  editChannelMessageWithFile,
  deleteChannelMessage,
  pinChannelMessage,
  isMessagePinned,
  NO_MENTIONS,
  SUPPRESS_EMBEDS,
  type MessageFile,
} from './discord';
import { bracketPng } from './bracket-image';
import { formatHelsinki, formatHelsinkiRange } from './time';

// Participant keys ('u:<discord id>' / 't:<team id>') to display names.
export async function participantNames(db: D1Database, eventId: number): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const signup of await listSignups(db, eventId)) names.set(`u:${signup.discord_id}`, signup.username);
  for (const team of await listEventTeams(db, eventId)) names.set(`t:${team.id}`, team.name);
  return names;
}

// Names are typed by members: no markdown, no masked links, no pings.
function safe(name: string): string {
  return name.replace(/[`*_~|>\[\]()@#]/g, '').replace(/\s+/g, ' ').trim() || 'Unknown';
}

export function nameOf(names: Map<string, string>, key: string | null): string {
  return key === null ? 'Unknown' : safe(names.get(key) ?? 'Unknown');
}

export function roundLabel(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinal';
  if (fromEnd === 2) return 'Quarterfinal';
  return `Round ${round}`;
}

export function signupsLine(closed: boolean, counts: { teams: number | null; players: number }): string {
  const who = counts.teams !== null ? `${counts.teams} teams, ${counts.players} players in` : `${counts.players} going`;
  return closed ? `🔒 Signups are closed: ${who}.` : `🔓 Signups are open again: ${who}.`;
}

export function bracketLine(matches: BracketMatch[], names: Map<string, string>, url: string, regenerated: boolean): string {
  const total = matches.reduce((max, m) => Math.max(max, m.round), 0);
  const first = matches.filter((m) => m.round === 1);
  const pairs = first.filter((m) => m.side_a !== null && m.side_b !== null).map((m) => `${nameOf(names, m.side_a)} vs ${nameOf(names, m.side_b)}`);
  const byes = first.filter((m) => m.side_a !== null && m.side_b === null).map((m) => nameOf(names, m.side_a));
  const entrants = first.reduce((n, m) => n + (m.side_a ? 1 : 0) + (m.side_b ? 1 : 0), 0);
  const head = `🎲 ${regenerated ? 'The bracket was redrawn' : 'The bracket is out'}: ${entrants} ${matches.some((m) => m.side_a?.startsWith('t:') || m.side_b?.startsWith('t:')) ? 'teams' : 'players'}, ${total} ${total === 1 ? 'round' : 'rounds'}.`;
  const lines = [head];
  if (pairs.length > 0) lines.push(`${roundLabel(1, total)}: ${pairs.join(' · ')}.`);
  if (byes.length > 0) lines.push(`${byes.join(', ')} ${byes.length === 1 ? 'skips' : 'skip'} straight to ${roundLabel(2, total).toLowerCase()}.`);
  lines.push(url);
  return lines.join('\n');
}

export interface ResultStory {
  round: number;
  totalRounds: number;
  winner: string;
  loser: string;
  next: { a: string; b: string } | null; // the winner's next match, when both sides are known
}

// What a recorded result means, read back from the bracket after the
// update: who beat whom, and the winner's next opponent if known. Null
// when the match doesn't exist or is undecided (nothing to say).
export function describeResult(matches: BracketMatch[], round: number, slot: number, names: Map<string, string>): ResultStory | null {
  const match = matches.find((m) => m.round === round && m.slot === slot);
  if (!match?.winner || match.side_a === null || match.side_b === null) return null;
  const totalRounds = matches.reduce((max, m) => Math.max(max, m.round), 0);
  const loserKey = match.winner === match.side_a ? match.side_b : match.side_a;
  const upcoming = matches.find((m) => m.round === round + 1 && m.slot === Math.floor(slot / 2));
  const next = upcoming && upcoming.side_a !== null && upcoming.side_b !== null ? { a: nameOf(names, upcoming.side_a), b: nameOf(names, upcoming.side_b) } : null;
  return { round, totalRounds, winner: nameOf(names, match.winner), loser: nameOf(names, loserKey), next };
}

export function resultLine(story: ResultStory, url: string): string {
  if (story.round === story.totalRounds) return `🥇 Champion: **${story.winner}**! They beat ${story.loser} in the final.\n${url}`;
  const label = roundLabel(story.round, story.totalRounds);
  const next = story.next ? ` Next up: ${story.next.a} vs ${story.next.b}.` : '';
  return `🏆 ${label}: ${story.winner} beat ${story.loser}.${next}`;
}

export function revertLine(round: number, totalRounds: number, a: string, b: string): string {
  return `↩️ ${roundLabel(round, totalRounds)}: ${a} vs ${b} is undecided again.`;
}

export function screenLine(note: string): string {
  return `📺 ${safe(note)}`;
}

export function cancelLine(event: Pick<EventRow, 'title' | 'starts_at'>, cancelled: boolean): string {
  return cancelled
    ? `❌ **${safe(event.title)}** is cancelled (was ${formatHelsinki(event.starts_at)}).`
    : `✅ **${safe(event.title)}** is back on: ${formatHelsinki(event.starts_at)}.`;
}

// Only a new time or place is worth a line; other edits stay quiet.
export function changeLine(
  before: Pick<EventRow, 'starts_at' | 'ends_at' | 'location'>,
  after: Pick<EventRow, 'starts_at' | 'ends_at' | 'location'>,
): string | null {
  const parts: string[] = [];
  if (before.starts_at !== after.starts_at || before.ends_at !== after.ends_at) parts.push(`new time: ${formatHelsinkiRange(after.starts_at, after.ends_at)}`);
  if ((before.location ?? '') !== (after.location ?? '')) parts.push(after.location ? `new place: ${safe(after.location)}` : 'the place was removed');
  if (parts.length === 0) return null;
  return `✏️ ${parts.join('; ')}.`;
}

// --- the pinned live bracket ------------------------------------------------------

const MESSAGE_MAX = 1900; // Discord allows 2000; leave room for the link

// The whole bracket as text: every round, winners ticked, byes named,
// unknown sides as a dash, the champion on top once decided. Earliest
// rounds are dropped first when it would not fit in one message.
export function liveBracketText(matches: BracketMatch[], names: Map<string, string>, url: string, now: number): string {
  const total = matches.reduce((max, m) => Math.max(max, m.round), 0);
  const side = (key: string | null, winner: string | null) => (key === null ? '—' : `${nameOf(names, key)}${winner !== null && winner === key ? ' ✅' : ''}`);
  const rounds: string[] = [];
  for (let round = 1; round <= total; round++) {
    const lines = matches
      .filter((m) => m.round === round)
      .map((m) => (m.side_a !== null && m.side_b === null && m.winner === m.side_a ? `${nameOf(names, m.side_a)} advances (bye)` : `${side(m.side_a, m.winner)} vs ${side(m.side_b, m.winner)}`));
    const label = roundLabel(round, total);
    rounds.push(`**${label === 'Final' || label.startsWith('Round') ? label : `${label}s`}**\n${lines.join('\n')}`);
  }
  const final = matches.find((m) => m.round === total && m.slot === 0);
  const head = [`📋 **Live bracket** · updated ${formatHelsinki(now)}`];
  if (final?.winner) head.push(`🥇 Champion: **${nameOf(names, final.winner)}**`);
  let body = rounds;
  while (body.length > 1 && [...head, ...body].join('\n\n').length > MESSAGE_MAX) body = ['… earlier rounds on the site', ...body.slice(2)];
  return [...head, ...body, url].join('\n\n');
}

// The bracket as a picture, ready to attach.
export async function bracketPicture(event: Pick<EventRow, 'title'>, matches: BracketMatch[], names: Map<string, string>, now: number): Promise<MessageFile> {
  const bytes = await bracketPng({ matches, names, title: event.title, subtitle: `updated ${formatHelsinki(now)}` });
  return { name: 'bracket.png', bytes, type: 'image/png' };
}

// After the final: the champion's stats card, or one per team member (at
// most five), on a single message under the champion line.
export async function postChampionCards(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number, matches: BracketMatch[], now: number): Promise<void> {
  const token = env.DISCORD_BOT_TOKEN;
  const event = await getEvent(db, eventId);
  if (!token || !event?.discord_channel_id) return;
  const total = matches.reduce((max, m) => Math.max(max, m.round), 0);
  const final = matches.find((m) => m.round === total && m.slot === 0);
  if (!final?.winner) return;
  const signups = await listSignups(db, eventId);
  const ids = final.winner.startsWith('t:')
    ? signups.filter((s) => s.event_team_id === Number(final.winner!.slice(2))).map((s) => s.discord_id)
    : [final.winner.slice(2)];
  const people = ids.filter((id) => /^\d{5,25}$/.test(id)).slice(0, 5);
  if (people.length === 0) return;
  await awardChampionRole(db, env, people, now);
  await postWinMilestones(db, env as { WELCOME_WEBHOOK_URL?: string }, people, new Map(signups.map((s) => [`u:${s.discord_id}`, s.username])), now);
  const files: MessageFile[] = [];
  for (const id of people) {
    const name = signups.find((s) => s.discord_id === id)?.username ?? 'Champion';
    files.push({ name: `champion-${id}.png`, bytes: await profileCardPng(name, await memberStats(db, id, now + 1)), type: 'image/png' });
  }
  const line = people.length === 1 ? `🏅 The champion's card.` : `🏅 The champions' cards.`;
  await createChannelMessageWithFile(token, event.discord_channel_id, line, files, NO_MENTIONS, SUPPRESS_EMBEDS);
}

// Someone was put in a team by its captain or the board: a private
// message, or a mention in the event's channel when DMs are closed.
export async function notifyTeamPlacement(
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string },
  eventId: number,
  placements: { discordId: string; teamId: number }[],
  origin: string,
): Promise<void> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token || placements.length === 0) return;
  const event = await getEvent(db, eventId);
  if (!event) return;
  const teams = new Map((await listEventTeams(db, eventId)).map((t) => [t.id, t.name]));
  for (const { discordId, teamId } of placements) {
    if (!/^\d{5,25}$/.test(discordId)) continue;
    const team = teams.get(teamId);
    if (!team) continue;
    const line = `🎮 You're in team **${safe(team)}** for **${safe(event.title)}** (${formatHelsinkiRange(event.starts_at, event.ends_at)}). ${origin}/events/${eventId}`;
    if (await dmUser(token, discordId, line)) continue;
    if (event.discord_channel_id) {
      await postChannelMessage(token, event.discord_channel_id, `<@${discordId}> ${line}`, { parse: [], users: [discordId] }, SUPPRESS_EMBEDS);
    }
  }
}

// First win, fifth, tenth: told in the general channel, for members who
// chose the leaderboard.
export async function postWinMilestones(
  db: D1Database,
  env: { WELCOME_WEBHOOK_URL?: string },
  winners: string[],
  names: Map<string, string>,
  now: number,
): Promise<void> {
  if (!env.WELCOME_WEBHOOK_URL) return;
  for (const id of winners) {
    const member = await db.prepare('SELECT username, leaderboard FROM members WHERE discord_id = ?1').bind(id).first<{ username: string; leaderboard: number }>();
    if (!member || member.leaderboard !== 1) continue;
    const stats = await memberStats(db, id, now + 1);
    if (!WIN_MILESTONES.includes(stats.wins)) continue;
    if (!(await recordMilestone(db, id, 'wins', stats.wins, now))) continue;
    const what = stats.wins === 1 ? 'their first tournament win' : `their ${stats.wins}th tournament win`;
    await postWebhook(env.WELCOME_WEBHOOK_URL, `🏆 **${safe(names.get(`u:${id}`) ?? member.username)}** just took ${what}!`, NO_MENTIONS, SUPPRESS_EMBEDS);
  }
}

// The reigning champion role: on the latest winners, off the previous
// holders. Which role is chosen on the register page; the holders are
// remembered in settings so they can be cleared next time.
export async function awardChampionRole(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, winners: string[], now: number): Promise<void> {
  const token = env.DISCORD_BOT_TOKEN;
  const settings = await getSettings(db);
  const role = settings.champion_role_id;
  if (!token || !role) return;
  const previous: string[] = (() => {
    try {
      return JSON.parse(settings.champion_holders ?? '[]') as string[];
    } catch {
      return [];
    }
  })();
  for (const id of previous) if (!winners.includes(id)) await setGuildMemberRole(token, DISCORD_GUILD_ID, id, role, false);
  for (const id of winners) await setGuildMemberRole(token, DISCORD_GUILD_ID, id, role, true);
  await setSetting(db, 'champion_holders', JSON.stringify(winners), 'bot', now);
}

// "Photos are up": a few of the new pictures into the event's channel, or
// the general channel when the event has none. Never the announcements.
export async function postPhotosNotice(
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string; WELCOME_WEBHOOK_URL?: string },
  eventId: number,
  photoIds: number[],
  origin: string,
): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event || photoIds.length === 0) return;
  const files: MessageFile[] = [];
  for (const id of photoIds.slice(0, 4)) {
    const photo = await getEventPhoto(db, id, false);
    if (photo) files.push({ name: `photo-${id}.${photo.content_type === 'image/png' ? 'png' : photo.content_type === 'image/webp' ? 'webp' : 'jpg'}`, bytes: new Uint8Array(photo.bytes), type: photo.content_type });
  }
  if (files.length === 0) return;
  const line = `📸 Photos from **${safe(event.title)}** are up${photoIds.length > files.length ? ` (${photoIds.length} in all)` : ''}: ${origin}/events/${eventId}#photos`;
  if (event.discord_channel_id && env.DISCORD_BOT_TOKEN) {
    await createChannelMessageWithFile(env.DISCORD_BOT_TOKEN, event.discord_channel_id, line, files, NO_MENTIONS, SUPPRESS_EMBEDS);
  } else if (env.WELCOME_WEBHOOK_URL) {
    await postWebhookWithFile(env.WELCOME_WEBHOOK_URL, line, files);
  }
}

// Where the live bracket lives: a big event's bot-only bracket channel,
// else the event's one channel.
async function bracketChannel(db: D1Database, event: Pick<EventRow, 'id' | 'discord_channel_id'>): Promise<string | null> {
  const own = await db
    .prepare("SELECT channel_id FROM event_discord_channels WHERE event_id = ?1 AND kind = 'bracket'")
    .bind(event.id)
    .first<{ channel_id: string }>();
  return own?.channel_id ?? event.discord_channel_id;
}

// Create or update the pinned message; a message deleted on Discord's
// side is made again. Nothing to show when there is no bracket.
export async function refreshLiveBracket(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number, origin: string, now: number): Promise<void> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;
  const event = await getEvent(db, eventId);
  if (!event || event.bracket_live_at === null) return; // a draft stays on the site
  const channelId = await bracketChannel(db, event);
  if (!channelId) return;
  const matches = await getBracket(db, eventId);
  if (matches.length === 0) {
    await dropLiveBracket(db, env, eventId);
    return;
  }
  const names = await participantNames(db, eventId);
  const text = liveBracketText(matches, names, `${origin}/events/${eventId}/bracket`, now);
  const picture = await bracketPicture(event, matches, names, now);
  if (event.discord_bracket_message_id) {
    const edited = await editChannelMessageWithFile(token, channelId, event.discord_bracket_message_id, text, picture, SUPPRESS_EMBEDS);
    if (edited.ok) {
      // A pin that failed earlier (or was removed) is put back.
      const pinned = await isMessagePinned(token, channelId, event.discord_bracket_message_id);
      const repinned = pinned === false ? await pinChannelMessage(token, channelId, event.discord_bracket_message_id) : null;
      console.log(`discord live bracket: event ${eventId} edited, pinned=${pinned}, repin=${repinned}`);
      return;
    }
    if (edited.status !== 404) return;
  }
  const created = await createChannelMessageWithFile(token, channelId, text, picture, NO_MENTIONS, SUPPRESS_EMBEDS);
  if (!created.ok) return;
  await db.prepare('UPDATE events SET discord_bracket_message_id = ?2 WHERE id = ?1').bind(eventId, created.value.id).run();
  const pinned = await pinChannelMessage(token, channelId, created.value.id);
  console.log(`discord live bracket: event ${eventId} created ${created.value.id}, pin=${pinned}`);
}

// The bracket was deleted, or the message moves: so goes the message.
// It is looked for in the bracket channel first, then the one channel.
export async function dropLiveBracket(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event?.discord_bracket_message_id) return;
  if (env.DISCORD_BOT_TOKEN) {
    const own = await bracketChannel(db, event);
    for (const channelId of new Set([own, event.discord_channel_id])) {
      if (channelId && (await deleteChannelMessage(env.DISCORD_BOT_TOKEN, channelId, event.discord_bracket_message_id))) break;
    }
  }
  await db.prepare('UPDATE events SET discord_bracket_message_id = NULL WHERE id = ?1').bind(eventId).run();
}

// Post into the event's discussion channel, if it has one. `ping` puts
// the event role in front, for the lines everyone should see now.
export async function postEventLine(
  db: D1Database,
  env: { DISCORD_BOT_TOKEN?: string },
  eventId: number,
  content: string,
  ping = false,
  file?: MessageFile,
): Promise<boolean> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return false;
  const event = await getEvent(db, eventId);
  if (!event?.discord_channel_id) return false;
  const role = ping && event.discord_role_id ? event.discord_role_id : null;
  const text = role ? `<@&${role}> ${content}` : content;
  const mentions = role ? { parse: [], roles: [role] } : NO_MENTIONS;
  if (file) return (await createChannelMessageWithFile(token, event.discord_channel_id, text, file, mentions, SUPPRESS_EMBEDS)).ok;
  return postChannelMessage(token, event.discord_channel_id, text, mentions, SUPPRESS_EMBEDS);
}

// A one-channel event has the pinned live bracket, picture and all, in
// the same channel as the talk, so its lines skip the picture; a big
// event's talk is in discussion while the live bracket sits elsewhere.
async function pictureBelongsInTalk(db: D1Database, event: Pick<EventRow, 'id' | 'discord_channel_id'>): Promise<boolean> {
  return (await bracketChannel(db, event)) !== event.discord_channel_id;
}

// The lines that need the bracket read back after a change.
export async function postBracketOut(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number, origin: string, regenerated: boolean): Promise<void> {
  const matches = await getBracket(db, eventId);
  if (matches.length === 0) return;
  const event = await getEvent(db, eventId);
  if (!event || event.bracket_live_at === null) return;
  const names = await participantNames(db, eventId);
  const now = Math.floor(Date.now() / 1000);
  const picture = (await pictureBelongsInTalk(db, event)) ? await bracketPicture(event, matches, names, now) : undefined;
  await postEventLine(db, env, eventId, bracketLine(matches, names, `${origin}/events/${eventId}/bracket`, regenerated), true, picture);
  await refreshLiveBracket(db, env, eventId, origin, now);
}

export async function postResult(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number, origin: string, round: number, slot: number): Promise<void> {
  if ((await getEvent(db, eventId))?.bracket_live_at == null) return; // results on a draft stay quiet
  const matches = await getBracket(db, eventId);
  const names = await participantNames(db, eventId);
  const story = describeResult(matches, round, slot, names);
  if (!story) return;
  const now = Math.floor(Date.now() / 1000);
  const decided = story.round === story.totalRounds;
  const event = decided ? await getEvent(db, eventId) : null;
  // The champion's line carries the finished picture, unless the pinned one is right there.
  const picture = event && (await pictureBelongsInTalk(db, event)) ? await bracketPicture(event, matches, names, now) : undefined;
  await postEventLine(db, env, eventId, resultLine(story, `${origin}/events/${eventId}/bracket`), decided, picture);
  await refreshLiveBracket(db, env, eventId, origin, now);
  if (decided) await postChampionCards(db, env, eventId, matches, now);
}

export async function postRevert(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number, origin: string, round: number, slot: number): Promise<void> {
  if ((await getEvent(db, eventId))?.bracket_live_at == null) return;
  const matches = await getBracket(db, eventId);
  const match = matches.find((m) => m.round === round && m.slot === slot);
  if (!match || match.side_a === null || match.side_b === null) return;
  const names = await participantNames(db, eventId);
  const total = matches.reduce((max, m) => Math.max(max, m.round), 0);
  await postEventLine(db, env, eventId, revertLine(round, total, nameOf(names, match.side_a), nameOf(names, match.side_b)));
  await refreshLiveBracket(db, env, eventId, origin, Math.floor(Date.now() / 1000));
}

export async function postSignups(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, eventId: number, closed: boolean): Promise<void> {
  const event = await getEvent(db, eventId);
  if (!event?.discord_channel_id) return;
  const teams = event.team_size !== null ? (await listEventTeams(db, eventId)).length : null;
  await postEventLine(db, env, eventId, signupsLine(closed, { teams, players: event.yes_count }));
}

// People let in from the waitlist: told in the event's channel with a
// mention, and given the event role. Events without a channel just mark
// the promotion done; the person sees it on the site.
export async function announcePromotions(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, now: number): Promise<number> {
  const rows = await listUnannouncedPromotions(db);
  if (rows.length === 0) return 0;
  const byEvent = new Map<number, typeof rows>();
  for (const row of rows) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);
  for (const [eventId, group] of byEvent) {
    const event = await getEvent(db, eventId);
    if (event && env.DISCORD_BOT_TOKEN) {
      // A private message first; the event's channel gets a mention as well.
      for (const row of group) {
        await dmUser(env.DISCORD_BOT_TOKEN, row.discord_id, `🎟️ A seat opened up: you're in for **${safe(event.title)}** (${formatHelsinkiRange(event.starts_at, event.ends_at)}). See you there!`);
      }
      if (event.discord_channel_id) {
        const mentions = group.map((r) => `<@${r.discord_id}>`).join(' ');
        const line = `🎟️ A seat opened up: ${mentions}, you're in for **${safe(event.title)}**! ${group.length === 1 ? 'You are' : 'You are all'} on the going list now.`;
        await postChannelMessage(env.DISCORD_BOT_TOKEN, event.discord_channel_id, line, { parse: [], users: group.map((r) => r.discord_id) }, SUPPRESS_EMBEDS);
      }
    }
    await markPromotionsAnnounced(db, group.map((r) => r.id), now);
    await syncEventRole(db, env, eventId, now);
  }
  return rows.length;
}

export function announcePromotionsInBackground(ctx: { waitUntil(promise: Promise<unknown>): void } | undefined, db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, now: number): void {
  ctx?.waitUntil(announcePromotions(db, env, now).catch(() => {}));
}

// Fire and forget from a route: the response goes out, the line follows.
export function later(ctx: { waitUntil(promise: Promise<unknown>): void } | undefined, work: Promise<unknown>): void {
  ctx?.waitUntil(work.catch(() => {}));
}
