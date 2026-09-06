import type { D1Database } from '@cloudflare/workers-types';
import { RuleError } from './db';

// The Minecraft server's whitelist lives here; the server pulls it every
// few minutes (scripts/minecraft/whitelist-sync.py) through
// /api/minecraft/whitelist. A member has one name of their own and can
// bring a couple of friends along on their membership; the board can add
// any name. A member's names count while the register lists them as a
// current member, board names always.
//
// Every name is checked against Mojang when it is saved: the account's
// UUID and the exact spelling are stored, an unknown name is refused, and
// the skin's face shows next to the name so people see it is theirs.

export const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;
export const FRIENDS_PER_MEMBER = 2;

// The servers a name can be for. Each runs its own copy of the sync with
// SERVER=<slug> in its config and pulls /api/minecraft/whitelist?server=<slug>.
export const SERVERS = [
  { slug: 'smp', label: 'SMP' },
  { slug: 'gtnh', label: 'GT:NH modpack' },
] as const;
export type ServerSlug = (typeof SERVERS)[number]['slug'];
export const ALL_SERVERS: ServerSlug[] = SERVERS.map((s) => s.slug);

// "all", empty or missing means every server; otherwise slugs separated
// by commas, in the fixed order, each once.
export function parseServers(raw: string | null | undefined): ServerSlug[] {
  const text = (raw ?? '').trim().toLowerCase();
  if (text === '' || text === 'all' || text === 'both') return [...ALL_SERVERS];
  const picked = new Set(text.split(',').map((s) => s.trim()).filter(Boolean));
  const out = ALL_SERVERS.filter((s) => picked.has(s));
  if (out.length !== picked.size) throw new RuleError('bad_input', 'Unknown server.');
  return out;
}

// True when a name is for fewer than all the servers.
export function narrowed(stored: string): boolean {
  return parseServers(stored).length < ALL_SERVERS.length;
}

export function serversLabel(stored: string): string {
  const slugs = parseServers(stored);
  if (slugs.length === ALL_SERVERS.length) return SERVERS.map((s) => s.label).join(' + ');
  return SERVERS.filter((s) => slugs.includes(s.slug)).map((s) => s.label).join(' + ');
}

export type MinecraftKind = 'own' | 'friend' | 'board';

export interface MinecraftName {
  id: number;
  discord_id: string;
  name: string;
  kind: MinecraftKind;
  added_at: number;
  uuid: string | null; // null only on names from before the lookup existed
  servers: string; // comma-separated slugs, see SERVERS
  approved_at: number | null; // a friend waits for the board; own and board names are approved at once
  approved_by: string | null;
}

export interface MinecraftNameRow extends MinecraftName {
  by_name: string | null; // the Discord name of whoever added it
  member_current: number; // 1 when the owner is a current member
}

export interface MojangProfile {
  uuid: string; // dashed
  name: string; // the account's exact spelling
}

// Mojang's lookup, swapped for a table in tests.
export type Resolver = (name: string) => Promise<MojangProfile | null>;

export function checkMinecraftName(raw: string): string {
  const name = raw.trim();
  if (!MC_NAME.test(name)) throw new RuleError('bad_name', 'A Minecraft name is 3 to 16 letters, digits or underscores.');
  return name;
}

export function dashedUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toLowerCase();
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function lookupMojang(name: string): Promise<MojangProfile | null> {
  let response: Response;
  try {
    response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json', 'user-agent': 'lahtiag.fi whitelist (+https://lahtiag.fi)' },
    });
  } catch {
    throw new RuleError('mojang_down', "Mojang didn't answer. Try again in a minute.");
  }
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new RuleError('mojang_down', "Mojang didn't answer. Try again in a minute.");
  const data = (await response.json()) as { id?: string; name?: string };
  if (!data.id || data.id.length !== 32 || !data.name) return null;
  return { uuid: dashedUuid(data.id), name: data.name };
}

async function resolveName(raw: string, resolve: Resolver): Promise<MojangProfile> {
  const typed = checkMinecraftName(raw);
  const profile = await resolve(typed);
  if (!profile) throw new RuleError('no_account', 'No Minecraft account has that name. Check the spelling.');
  return profile;
}

// The face of a skin, served through the site (src/pages/membership/minecraft/face).
export function faceUrl(origin: string, uuid: string): string {
  return `${origin}/membership/minecraft/face/${uuid}`;
}

export async function isCurrentMember(db: D1Database, discordId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM register WHERE discord_id = ?1 AND status = 'member'`).bind(discordId).first();
  return row !== null;
}

// A person's own names: theirs and their friends'. Names the board added
// belong to the board, whoever typed them, and live on the board's table.
export async function listMinecraftNames(db: D1Database, discordId: string): Promise<MinecraftName[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM minecraft_names WHERE discord_id = ?1 AND kind IN ('own', 'friend')
       ORDER BY CASE kind WHEN 'own' THEN 0 ELSE 1 END, added_at, id`,
    )
    .bind(discordId)
    .all<MinecraftName>();
  return results;
}

async function holderOf(db: D1Database, name: string): Promise<MinecraftName | null> {
  return db.prepare('SELECT * FROM minecraft_names WHERE name = ?1 COLLATE NOCASE').bind(name).first<MinecraftName>();
}

async function requireMember(db: D1Database, discordId: string): Promise<void> {
  if (!(await isCurrentMember(db, discordId))) throw new RuleError('not_member', 'Whitelisting needs a current membership.');
}

// A name the board added belongs to nobody yet: a member may claim it as
// their own or as a friend (the server's hand-made list was seeded that
// way). A name another member holds is taken.
function claimable(holder: MinecraftName | null, discordId: string): boolean {
  return holder === null || holder.discord_id === discordId || holder.kind === 'board';
}

// One own name per member: the previous one goes. A name already listed
// as one of their friends becomes their own.
export async function setOwnMinecraftName(db: D1Database, discordId: string, raw: string, now: number, resolve: Resolver = lookupMojang, servers?: string | null): Promise<MojangProfile> {
  const on = parseServers(servers).join(',');
  const profile = await resolveName(raw, resolve);
  await requireMember(db, discordId);
  if (!claimable(await holderOf(db, profile.name), discordId)) throw new RuleError('name_taken', 'That name is already on the list.');
  await db.batch([
    db
      .prepare(
        `DELETE FROM minecraft_names WHERE (discord_id = ?1 AND kind = 'own')
         OR (name = ?2 COLLATE NOCASE AND (discord_id = ?1 OR kind = 'board'))`,
      )
      .bind(discordId, profile.name),
    db
      .prepare(`INSERT INTO minecraft_names (discord_id, name, kind, added_at, uuid, servers, approved_at, approved_by) VALUES (?1, ?2, 'own', ?3, ?4, ?5, ?3, ?1)`)
      .bind(discordId, profile.name, now, profile.uuid, on),
  ]);
  return profile;
}

// A friend waits for the board's approval, unless the name was a board
// name already (then the board has said yes once, and it stays on).
export async function addMinecraftFriend(db: D1Database, discordId: string, raw: string, now: number, resolve: Resolver = lookupMojang, servers?: string | null): Promise<MojangProfile & { approved: boolean }> {
  const on = parseServers(servers).join(',');
  const profile = await resolveName(raw, resolve);
  await requireMember(db, discordId);
  const holder = await holderOf(db, profile.name);
  if (holder && holder.kind !== 'board') throw new RuleError('name_taken', 'That name is already on the list.');
  const approved = holder?.kind === 'board';
  const friends = await db
    .prepare(`SELECT COUNT(*) AS n FROM minecraft_names WHERE discord_id = ?1 AND kind = 'friend'`)
    .bind(discordId)
    .first<{ n: number }>();
  if ((friends?.n ?? 0) >= FRIENDS_PER_MEMBER) throw new RuleError('friend_limit', `${FRIENDS_PER_MEMBER} friends per member.`);
  await db.batch([
    db.prepare(`DELETE FROM minecraft_names WHERE name = ?1 COLLATE NOCASE AND kind = 'board'`).bind(profile.name),
    db
      .prepare(`INSERT INTO minecraft_names (discord_id, name, kind, added_at, uuid, servers, approved_at, approved_by) VALUES (?1, ?2, 'friend', ?3, ?4, ?5, ?6, ?7)`)
      .bind(discordId, profile.name, now, profile.uuid, on, approved ? (holder?.approved_at ?? now) : null, approved ? (holder?.approved_by ?? 'board') : null),
  ]);
  return { ...profile, approved };
}

// A friend is an application until the board approves it.
export async function listPendingFriends(db: D1Database): Promise<MinecraftNameRow[]> {
  const { results } = await db
    .prepare(
      `SELECT n.*, m.username AS by_name, (r.id IS NOT NULL) AS member_current
       FROM minecraft_names n
       LEFT JOIN members m ON m.discord_id = n.discord_id
       LEFT JOIN register r ON r.discord_id = n.discord_id AND r.status = 'member'
       WHERE n.kind = 'friend' AND n.approved_at IS NULL
       ORDER BY n.added_at, n.id`,
    )
    .all<MinecraftNameRow>();
  return results;
}

export async function listAllMinecraftNames(db: D1Database): Promise<MinecraftNameRow[]> {
  const { results } = await db
    .prepare(
      `SELECT n.*, m.username AS by_name, (r.id IS NOT NULL) AS member_current
       FROM minecraft_names n
       LEFT JOIN members m ON m.discord_id = n.discord_id
       LEFT JOIN register r ON r.discord_id = n.discord_id AND r.status = 'member'
       ORDER BY (n.approved_at IS NULL) DESC, n.name COLLATE NOCASE`,
    )
    .all<MinecraftNameRow>();
  return results;
}

export async function approveMinecraftName(db: D1Database, raw: string, by: string, now: number): Promise<MinecraftNameRow | null> {
  const name = raw.trim();
  if (!MC_NAME.test(name)) return null;
  const pending = (await listPendingFriends(db)).find((n) => n.name.toLowerCase() === name.toLowerCase());
  if (!pending) return null;
  await db.prepare('UPDATE minecraft_names SET approved_at = ?2, approved_by = ?3 WHERE id = ?1').bind(pending.id, now, by).run();
  return { ...pending, approved_at: now, approved_by: by };
}

// A pending friend turned down: the row goes, the member hears why.
export async function declineMinecraftName(db: D1Database, raw: string): Promise<MinecraftNameRow | null> {
  const name = raw.trim();
  if (!MC_NAME.test(name)) return null;
  const pending = (await listPendingFriends(db)).find((n) => n.name.toLowerCase() === name.toLowerCase());
  if (!pending) return null;
  await db.prepare('DELETE FROM minecraft_names WHERE id = ?1').bind(pending.id).run();
  return pending;
}

// The board's line about a friend request; the buttons come from board-channel.ts.
export function friendRequestLine(who: string, name: string, servers: string, origin: string): string {
  const where = narrowed(servers) ? `${serversLabel(servers)} only` : 'every server';
  return `🎮 **Whitelist request**: ${who} asks to whitelist **${name}** (a friend) on ${where}. Approve below, with \`/whitelist approve ${name}\`, or at ${origin}/whitelist`;
}

// A member takes one of their own names off; board names stay.
export async function removeMinecraftName(db: D1Database, discordId: string, raw: string): Promise<boolean> {
  const name = raw.trim();
  if (!MC_NAME.test(name)) return false;
  const result = await db
    .prepare(`DELETE FROM minecraft_names WHERE discord_id = ?1 AND name = ?2 COLLATE NOCASE AND kind IN ('own', 'friend')`)
    .bind(discordId, name)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// The board: any name, membership or not, and any name off again.
export async function addBoardMinecraftName(db: D1Database, byDiscordId: string, raw: string, now: number, resolve: Resolver = lookupMojang, servers?: string | null): Promise<MojangProfile> {
  const on = parseServers(servers).join(',');
  const profile = await resolveName(raw, resolve);
  if (await holderOf(db, profile.name)) throw new RuleError('name_taken', 'That name is already on the list.');
  await db
    .prepare(`INSERT INTO minecraft_names (discord_id, name, kind, added_at, uuid, servers, approved_at, approved_by) VALUES (?1, ?2, 'board', ?3, ?4, ?5, ?3, ?1)`)
    .bind(byDiscordId, profile.name, now, profile.uuid, on)
    .run();
  return profile;
}

export async function dropMinecraftName(db: D1Database, raw: string): Promise<MinecraftName | null> {
  const name = raw.trim();
  if (!MC_NAME.test(name)) return null;
  const holder = await holderOf(db, name);
  if (!holder) return null;
  await db.prepare('DELETE FROM minecraft_names WHERE id = ?1').bind(holder.id).run();
  return holder;
}

// What a server should have: board names, and every name whose member
// is current, among the names meant for that server (every name when no
// server is given). A lapsed membership takes its names off on the next
// pull.
export async function whitelistPlayers(db: D1Database, server?: ServerSlug | null): Promise<{ name: string; uuid: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT n.name, n.uuid FROM minecraft_names n
       LEFT JOIN register r ON r.discord_id = n.discord_id AND r.status = 'member'
       WHERE (n.kind = 'board' OR r.id IS NOT NULL)
         AND n.approved_at IS NOT NULL
         AND (?1 IS NULL OR (',' || n.servers || ',') LIKE ('%,' || ?1 || ',%'))
       ORDER BY n.name COLLATE NOCASE`,
    )
    .bind(server ?? null)
    .all<{ name: string; uuid: string | null }>();
  return results;
}

export async function whitelistNames(db: D1Database, server?: ServerSlug | null): Promise<string[]> {
  return (await whitelistPlayers(db, server)).map((p) => p.name);
}

// The server's bearer token, compared without leaking where it differs.
export function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return match ? match[1] : null;
}

export function tokenMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
