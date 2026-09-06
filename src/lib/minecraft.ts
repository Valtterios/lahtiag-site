import type { D1Database } from '@cloudflare/workers-types';
import { RuleError } from './db';

// The Minecraft server's whitelist lives here; the server pulls it every
// few minutes (scripts/minecraft/whitelist-sync.py) through
// /api/minecraft/whitelist. A member has one name of their own and can
// bring a couple of friends along on their membership; the board can add
// any name. A member's names count while the register lists them as a
// current member, board names always.

export const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;
export const FRIENDS_PER_MEMBER = 2;

export type MinecraftKind = 'own' | 'friend' | 'board';

export interface MinecraftName {
  id: number;
  discord_id: string;
  name: string;
  kind: MinecraftKind;
  added_at: number;
}

export function checkMinecraftName(raw: string): string {
  const name = raw.trim();
  if (!MC_NAME.test(name)) throw new RuleError('bad_name', 'A Minecraft name is 3 to 16 letters, digits or underscores.');
  return name;
}

export async function isCurrentMember(db: D1Database, discordId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM register WHERE discord_id = ?1 AND status = 'member'`).bind(discordId).first();
  return row !== null;
}

export async function listMinecraftNames(db: D1Database, discordId: string): Promise<MinecraftName[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM minecraft_names WHERE discord_id = ?1
       ORDER BY CASE kind WHEN 'own' THEN 0 WHEN 'friend' THEN 1 ELSE 2 END, added_at, id`,
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
export async function setOwnMinecraftName(db: D1Database, discordId: string, raw: string, now: number): Promise<string> {
  const name = checkMinecraftName(raw);
  await requireMember(db, discordId);
  if (!claimable(await holderOf(db, name), discordId)) throw new RuleError('name_taken', 'That name is already on the list.');
  await db.batch([
    db
      .prepare(
        `DELETE FROM minecraft_names WHERE (discord_id = ?1 AND kind = 'own')
         OR (name = ?2 COLLATE NOCASE AND (discord_id = ?1 OR kind = 'board'))`,
      )
      .bind(discordId, name),
    db.prepare(`INSERT INTO minecraft_names (discord_id, name, kind, added_at) VALUES (?1, ?2, 'own', ?3)`).bind(discordId, name, now),
  ]);
  return name;
}

export async function addMinecraftFriend(db: D1Database, discordId: string, raw: string, now: number): Promise<string> {
  const name = checkMinecraftName(raw);
  await requireMember(db, discordId);
  const holder = await holderOf(db, name);
  if (holder && holder.kind !== 'board') throw new RuleError('name_taken', 'That name is already on the list.');
  const friends = await db
    .prepare(`SELECT COUNT(*) AS n FROM minecraft_names WHERE discord_id = ?1 AND kind = 'friend'`)
    .bind(discordId)
    .first<{ n: number }>();
  if ((friends?.n ?? 0) >= FRIENDS_PER_MEMBER) throw new RuleError('friend_limit', `${FRIENDS_PER_MEMBER} friends per member.`);
  await db.batch([
    db.prepare(`DELETE FROM minecraft_names WHERE name = ?1 COLLATE NOCASE AND kind = 'board'`).bind(name),
    db.prepare(`INSERT INTO minecraft_names (discord_id, name, kind, added_at) VALUES (?1, ?2, 'friend', ?3)`).bind(discordId, name, now),
  ]);
  return name;
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
export async function addBoardMinecraftName(db: D1Database, byDiscordId: string, raw: string, now: number): Promise<string> {
  const name = checkMinecraftName(raw);
  if (await holderOf(db, name)) throw new RuleError('name_taken', 'That name is already on the list.');
  await db.prepare(`INSERT INTO minecraft_names (discord_id, name, kind, added_at) VALUES (?1, ?2, 'board', ?3)`).bind(byDiscordId, name, now).run();
  return name;
}

export async function dropMinecraftName(db: D1Database, raw: string): Promise<MinecraftName | null> {
  const name = raw.trim();
  if (!MC_NAME.test(name)) return null;
  const holder = await holderOf(db, name);
  if (!holder) return null;
  await db.prepare('DELETE FROM minecraft_names WHERE id = ?1').bind(holder.id).run();
  return holder;
}

// What the server should have: board names, and every name whose member
// is current. A lapsed membership takes its names off on the next pull.
export async function whitelistNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT n.name FROM minecraft_names n
       LEFT JOIN register r ON r.discord_id = n.discord_id AND r.status = 'member'
       WHERE n.kind = 'board' OR r.id IS NOT NULL
       ORDER BY n.name COLLATE NOCASE`,
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
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
