import type { D1Database } from '@cloudflare/workers-types';
import { RuleError } from './db';
import { DISCORD_GUILD_ID } from './config';
import { setGuildMemberRole } from './discord';

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
  { slug: 'smp', label: 'SMP', address: 'mc.lahtiag.fi' },
  { slug: 'gtnh', label: 'GT:NH modpack', address: 'gtnh.lahtiag.fi' },
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

// Three places that answer "which account has this name": Mojang's old
// API first, its newer services endpoint, then PlayerDB. Cloudflare's
// shared addresses get refused or rate-limited by Mojang at times, so a
// refusal moves on to the next; only a clear "no such name" is final.
interface Lookup {
  source: string;
  url: (name: string) => string;
  // The raw id (32 hex) and the exact name, null for "no such account".
  parse: (data: unknown, status: number) => { id: string; name: string } | null | 'down';
}

const plain = (data: unknown): { id: string; name: string } | null | 'down' => {
  const d = data as { id?: string; name?: string; errorMessage?: string } | null;
  if (d && typeof d.id === 'string' && d.id.length === 32 && typeof d.name === 'string') return { id: d.id, name: d.name };
  if (d && d.errorMessage) return null;
  return 'down';
};

const LOOKUPS: Lookup[] = [
  { source: 'mojang', url: (n) => `https://api.mojang.com/users/profiles/minecraft/${n}`, parse: plain },
  { source: 'minecraftservices', url: (n) => `https://api.minecraftservices.com/minecraft/profile/lookup/name/${n}`, parse: plain },
  {
    source: 'playerdb',
    url: (n) => `https://playerdb.co/api/player/minecraft/${n}`,
    parse: (data) => {
      const d = data as { success?: boolean; code?: string; data?: { player?: { raw_id?: string; username?: string } } } | null;
      const p = d?.data?.player;
      if (d?.success && p && typeof p.raw_id === 'string' && p.raw_id.length === 32 && typeof p.username === 'string') return { id: p.raw_id, name: p.username };
      if (d && d.success === false && /invalid|not.?found/i.test(d.code ?? '')) return null;
      return 'down';
    },
  },
];

export async function lookupMojang(name: string): Promise<MojangProfile | null> {
  for (const lookup of LOOKUPS) {
    let response: Response;
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 6000);
      response = await fetch(lookup.url(encodeURIComponent(name)), {
        headers: { accept: 'application/json', 'user-agent': 'lahtiag.fi whitelist (+https://lahtiag.fi)' },
        signal: abort.signal,
      });
      clearTimeout(timer);
    } catch (error) {
      console.log(`minecraft lookup: ${lookup.source} unreachable (${error instanceof Error ? error.message : 'error'})`);
      continue;
    }
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) {
      console.log(`minecraft lookup: ${lookup.source} answered ${response.status}`);
      continue;
    }
    let parsed: ReturnType<Lookup['parse']>;
    try {
      parsed = lookup.parse(await response.json(), response.status);
    } catch {
      parsed = 'down';
    }
    if (parsed === 'down') {
      console.log(`minecraft lookup: ${lookup.source} answered oddly`);
      continue;
    }
    if (parsed === null) return null;
    return { uuid: dashedUuid(parsed.id), name: parsed.name };
  }
  throw new RuleError('mojang_down', "Mojang didn't answer. Try again in a minute.");
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

// Who may take a name that is on the list already:
// - a board name belongs to nobody yet (the server's hand-made list was
//   seeded that way): anyone may claim it, as their own or as a friend;
// - a member's own claim wins over a friend listing: the friend who
//   joined takes their name with them, and the slot frees up;
// - a name whose holder is no longer a current member is free again.
// A current member's own name, or another member's friend when asking
// as a friend, is taken.
async function claimable(db: D1Database, holder: MinecraftName | null, discordId: string, asOwn: boolean): Promise<boolean> {
  if (holder === null || holder.discord_id === discordId || holder.kind === 'board') return true;
  if (asOwn && holder.kind === 'friend') return true;
  return !(await isCurrentMember(db, holder.discord_id));
}

// One own name per member: the previous one goes. A name already listed
// as one of their friends becomes their own.
export async function setOwnMinecraftName(
  db: D1Database,
  discordId: string,
  raw: string,
  now: number,
  resolve: Resolver = lookupMojang,
  servers?: string | null,
): Promise<MojangProfile & { takenFrom: string | null }> {
  const on = parseServers(servers).join(',');
  const profile = await resolveName(raw, resolve);
  await requireMember(db, discordId);
  const holder = await holderOf(db, profile.name);
  if (!(await claimable(db, holder, discordId, true))) throw new RuleError('name_taken', 'That name is already on the list.');
  // Whose friend slot frees up: another member who had listed this name.
  const takenFrom = holder && holder.discord_id !== discordId && holder.kind === 'friend' ? holder.discord_id : null;
  await db.batch([
    db.prepare(`DELETE FROM minecraft_names WHERE (discord_id = ?1 AND kind = 'own') OR name = ?2 COLLATE NOCASE`).bind(discordId, profile.name),
    db
      .prepare(`INSERT INTO minecraft_names (discord_id, name, kind, added_at, uuid, servers, approved_at, approved_by) VALUES (?1, ?2, 'own', ?3, ?4, ?5, ?3, ?1)`)
      .bind(discordId, profile.name, now, profile.uuid, on),
  ]);
  return { ...profile, takenFrom };
}

// A friend waits for the board's approval, unless the name was a board
// name already (then the board has said yes once, and it stays on).
export async function addMinecraftFriend(db: D1Database, discordId: string, raw: string, now: number, resolve: Resolver = lookupMojang, servers?: string | null): Promise<MojangProfile & { approved: boolean }> {
  const on = parseServers(servers).join(',');
  const profile = await resolveName(raw, resolve);
  await requireMember(db, discordId);
  const holder = await holderOf(db, profile.name);
  if (!(await claimable(db, holder, discordId, false))) throw new RuleError('name_taken', 'That name is already on the list.');
  const approved = holder?.kind === 'board';
  const friends = await db
    .prepare(`SELECT COUNT(*) AS n FROM minecraft_names WHERE discord_id = ?1 AND kind = 'friend'`)
    .bind(discordId)
    .first<{ n: number }>();
  if ((friends?.n ?? 0) >= FRIENDS_PER_MEMBER) throw new RuleError('friend_limit', `${FRIENDS_PER_MEMBER} friends per member.`);
  await db.batch([
    db.prepare(`DELETE FROM minecraft_names WHERE name = ?1 COLLATE NOCASE`).bind(profile.name),
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

// A current member with a linked Discord account, for the board to link a
// board name to; own_names says whether they already have one.
export interface LinkableMember {
  discord_id: string;
  full_name: string;
  username: string | null;
  discord_name: string | null;
  own_names: number;
}

export async function listLinkableMembers(db: D1Database): Promise<LinkableMember[]> {
  const { results } = await db
    .prepare(
      `SELECT r.discord_id, r.full_name, m.username, r.discord_name,
              (SELECT COUNT(*) FROM minecraft_names n WHERE n.discord_id = r.discord_id AND n.kind = 'own') AS own_names
       FROM register r LEFT JOIN members m ON m.discord_id = r.discord_id
       WHERE r.status = 'member' AND r.discord_id IS NOT NULL
       ORDER BY r.full_name COLLATE NOCASE`,
    )
    .all<LinkableMember>();
  return results;
}

// The member a board name most likely belongs to, by resemblance between
// the Minecraft name and their Discord names or first name; null when
// nothing resembles it. A hint for the board's picker, never a decision.
export function suggestLink(name: string, members: LinkableMember[]): LinkableMember | null {
  const fold = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = fold(name);
  if (wanted.length < 3) return null;
  const resembles = (v: string | null | undefined) => {
    const f = fold(v);
    return f.length >= 3 && (f === wanted || (f.length >= 4 && wanted.includes(f)) || (wanted.length >= 4 && f.includes(wanted)));
  };
  return members.find((m) => resembles(m.username) || resembles(m.discord_name)) ?? members.find((m) => resembles(m.full_name.split(/\s+/)[0])) ?? null;
}

// The board hands a board name to the member it belongs to: it becomes
// their own name, on every server, and follows their membership from then
// on. Only board names, only to current members without an own name.
export async function linkBoardName(db: D1Database, raw: string, discordId: string, by: string, now: number): Promise<MinecraftName> {
  const name = raw.trim();
  if (!MC_NAME.test(name)) throw new RuleError('bad_name', 'A Minecraft name is 3 to 16 letters, digits or underscores.');
  const holder = await holderOf(db, name);
  if (!holder || holder.kind !== 'board') throw new RuleError('missing', 'That is not a board name on the list.');
  await requireMember(db, discordId);
  const own = await db.prepare(`SELECT 1 AS x FROM minecraft_names WHERE discord_id = ?1 AND kind = 'own'`).bind(discordId).first();
  if (own) throw new RuleError('has_name', 'That member has an own name already; take it off first.');
  const servers = ALL_SERVERS.join(',');
  await db
    .prepare(`UPDATE minecraft_names SET discord_id = ?2, kind = 'own', servers = ?3, approved_at = COALESCE(approved_at, ?4), approved_by = ?5 WHERE id = ?1`)
    .bind(holder.id, discordId, servers, now, by)
    .run();
  return { ...holder, discord_id: discordId, kind: 'own', servers, approved_at: holder.approved_at ?? now, approved_by: by };
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
// The Minecraft role opens the game channels (the bridged chats, the
// rules, the guides) to the people who play. Given when a member puts
// their own name on the whitelist, or the board hands one to them:
// having a name on the server is the clearest sign they want the
// channels. Adding a role a member already holds changes nothing, and
// nothing here fails the whitelisting when the role cannot be given.
// True when the role is set up, so the reply can say the channels opened.
export async function grantMinecraftRole(env: { DISCORD_BOT_TOKEN?: string; MINECRAFT_ROLE_ID?: string }, discordId: string): Promise<boolean> {
  if (!env.DISCORD_BOT_TOKEN || !env.MINECRAFT_ROLE_ID) return false;
  const result = await setGuildMemberRole(env.DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, discordId, env.MINECRAFT_ROLE_ID, true);
  return result === 'ok';
}

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
