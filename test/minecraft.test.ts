import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  setOwnMinecraftName,
  addMinecraftFriend,
  removeMinecraftName,
  listMinecraftNames,
  addBoardMinecraftName,
  dropMinecraftName,
  whitelistNames,
  whitelistPlayers,
  listPendingFriends,
  listAllMinecraftNames,
  approveMinecraftName,
  declineMinecraftName,
  friendRequestLine,
  parseServers,
  serversLabel,
  narrowed,
  tokenMatches,
  bearerToken,
  dashedUuid,
  FRIENDS_PER_MEMBER,
  type Resolver,
} from '../src/lib/minecraft';

// The Minecraft whitelist: a member's own name and friends, board names,
// and what the server gets to see.

const NOW = 1_760_000_000;
const db = () => env.DB;

// Mojang, as a table: known names in their exact spelling, with UUIDs.
const KNOWN = ['Steve', 'Steve_2', 'Alex', 'Friend1', 'Friend2', 'Friend3', 'Zed', 'Guest', 'Seeded', 'Seeded2', 'Buddy', 'Pending', 'Ghost', 'Nope'];
const uuidOf = (name: string) => dashedUuid(name.toLowerCase().padEnd(32, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 32));
const mojang: Resolver = async (name) => {
  const exact = KNOWN.find((k) => k.toLowerCase() === name.toLowerCase());
  return exact ? { uuid: uuidOf(exact), name: exact } : null;
};

async function registered(discordId: string, status: 'member' | 'pending' | 'former'): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, status, source, applied_at, consented_at, updated_at)
       VALUES (?1, 'Lahti', ?2, 'LUT', 'LTKY', 'full', ?3, ?4, 'web', ?5, ?5, ?5)`,
    )
    .bind(`Person ${discordId}`, `${discordId}@example.com`, discordId, status, NOW)
    .run();
}

describe('minecraft whitelist', () => {
  beforeEach(async () => {
    for (const table of ['minecraft_names', 'register']) await db().prepare(`DELETE FROM ${table}`).run();
    await registered('m1', 'member');
    await registered('m2', 'member');
    await registered('m3', 'member');
    await registered('p1', 'pending');
  });

  it('takes a member’s own name once, checks the name, and refuses non-members', async () => {
    expect((await setOwnMinecraftName(db(), 'm1', ' steve ', NOW, mojang)).name).toBe('Steve'); // exact spelling from Mojang
    expect(await setOwnMinecraftName(db(), 'm1', 'Steve_2', NOW + 1, mojang)).toEqual({ name: 'Steve_2', uuid: uuidOf('Steve_2') });
    expect((await listMinecraftNames(db(), 'm1')).map((n) => [n.name, n.kind, n.uuid])).toEqual([['Steve_2', 'own', uuidOf('Steve_2')]]);
    await expect(setOwnMinecraftName(db(), 'm1', 'Nobody99', NOW, mojang)).rejects.toMatchObject({ code: 'no_account' });
    await expect(setOwnMinecraftName(db(), 'm1', 'no spaces here', NOW, mojang)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(setOwnMinecraftName(db(), 'm1', 'ab', NOW, mojang)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(setOwnMinecraftName(db(), 'p1', 'Pending', NOW, mojang)).rejects.toMatchObject({ code: 'not_member' });
    await expect(setOwnMinecraftName(db(), 'nobody', 'Ghost', NOW, mojang)).rejects.toMatchObject({ code: 'not_member' });
    // Someone else's name, in any case, is taken.
    await expect(setOwnMinecraftName(db(), 'm2', 'steve_2', NOW, mojang)).rejects.toMatchObject({ code: 'name_taken' });
  });

  it('brings friends up to the limit, and a friend promoted to own stays one row', async () => {
    await setOwnMinecraftName(db(), 'm1', 'Alex', NOW, mojang);
    await addMinecraftFriend(db(), 'm1', 'Friend1', NOW, mojang);
    await addMinecraftFriend(db(), 'm1', 'Friend2', NOW, mojang);
    expect(FRIENDS_PER_MEMBER).toBe(2);
    await expect(addMinecraftFriend(db(), 'm1', 'Friend3', NOW, mojang)).rejects.toMatchObject({ code: 'friend_limit' });
    await expect(addMinecraftFriend(db(), 'm2', 'friend1', NOW, mojang)).rejects.toMatchObject({ code: 'name_taken' });
    await expect(addMinecraftFriend(db(), 'p1', 'Nope', NOW, mojang)).rejects.toMatchObject({ code: 'not_member' });
    expect(await removeMinecraftName(db(), 'm1', 'Friend2')).toBe(true);
    expect(await removeMinecraftName(db(), 'm1', 'Friend2')).toBe(false);
    expect(await removeMinecraftName(db(), 'm2', 'Friend1')).toBe(false); // not theirs
    await setOwnMinecraftName(db(), 'm1', 'friend1', NOW + 5, mojang);
    expect((await listMinecraftNames(db(), 'm1')).map((n) => [n.name, n.kind])).toEqual([['Friend1', 'own']]);
  });

  it('lists board names always and members’ names while they are current', async () => {
    await setOwnMinecraftName(db(), 'm1', 'Alex', NOW, mojang);
    await addMinecraftFriend(db(), 'm1', 'Buddy', NOW, mojang);
    expect((await approveMinecraftName(db(), 'buddy', 'board', NOW))?.name).toBe('Buddy');
    await setOwnMinecraftName(db(), 'm2', 'Zed', NOW, mojang);
    await addBoardMinecraftName(db(), 'board', 'Guest', NOW, mojang);
    await expect(addBoardMinecraftName(db(), 'board', 'guest', NOW, mojang)).rejects.toMatchObject({ code: 'name_taken' });
    expect(await whitelistNames(db())).toEqual(['Alex', 'Buddy', 'Guest', 'Zed']);
    await db().prepare(`UPDATE register SET status = 'former' WHERE discord_id = 'm1'`).run();
    expect(await whitelistNames(db())).toEqual(['Guest', 'Zed']);
    // A seeded board name is claimable by a member, as their own or as a friend; then it follows them.
    await addBoardMinecraftName(db(), 'board', 'Seeded', NOW, mojang);
    await addBoardMinecraftName(db(), 'board', 'Seeded2', NOW, mojang);
    expect((await setOwnMinecraftName(db(), 'm2', 'seeded', NOW + 1, mojang)).name).toBe('Seeded');
    expect(await addMinecraftFriend(db(), 'm2', 'Seeded2', NOW + 1, mojang)).toMatchObject({ name: 'Seeded2', approved: true }); // a board name stays approved
    // Their previous own name (Zed) went with the claim; the claimed names are theirs now.
    expect((await listMinecraftNames(db(), 'm2')).map((n) => [n.name, n.kind])).toEqual([['Seeded', 'own'], ['Seeded2', 'friend']]);
    expect(await whitelistNames(db())).toEqual(['Guest', 'Seeded', 'Seeded2']);
    expect((await whitelistPlayers(db())).map((p) => p.uuid)).toEqual([uuidOf('Guest'), uuidOf('Seeded'), uuidOf('Seeded2')]);
    await expect(setOwnMinecraftName(db(), 'p1', 'Guest', NOW, mojang)).rejects.toMatchObject({ code: 'not_member' });
    await expect(setOwnMinecraftName(db(), 'm3', 'Seeded2', NOW, mojang)).rejects.toMatchObject({ code: 'name_taken' });
    await expect(addMinecraftFriend(db(), 'm3', 'seeded', NOW, mojang)).rejects.toMatchObject({ code: 'name_taken' });
    // The board drops any name; a member cannot take a board name off.
    expect(await removeMinecraftName(db(), 'board', 'Guest')).toBe(false);
    expect((await dropMinecraftName(db(), 'guest'))?.kind).toBe('board');
    expect((await dropMinecraftName(db(), 'seeded'))?.discord_id).toBe('m2');
    expect(await dropMinecraftName(db(), 'Zed')).toBeNull();
    expect(await whitelistNames(db())).toEqual(['Seeded2']);
  });

  it('puts a name on every server unless narrowed, and serves each server its own list', async () => {
    await setOwnMinecraftName(db(), 'm1', 'Alex', NOW, mojang);
    await addMinecraftFriend(db(), 'm1', 'Buddy', NOW, mojang, 'smp');
    await approveMinecraftName(db(), 'Buddy', 'board', NOW);
    await addBoardMinecraftName(db(), 'board', 'Guest', NOW, mojang, 'gtnh');
    expect((await listMinecraftNames(db(), 'm1')).map((n) => n.servers)).toEqual(['smp,gtnh', 'smp']);
    expect(await whitelistNames(db())).toEqual(['Alex', 'Buddy', 'Guest']);
    expect(await whitelistNames(db(), 'smp')).toEqual(['Alex', 'Buddy']);
    expect(await whitelistNames(db(), 'gtnh')).toEqual(['Alex', 'Guest']);
    await expect(setOwnMinecraftName(db(), 'm1', 'Alex', NOW, mojang, 'moon')).rejects.toMatchObject({ code: 'bad_input' });
    expect(parseServers(undefined)).toEqual(['smp', 'gtnh']);
    expect(parseServers('all')).toEqual(['smp', 'gtnh']);
    expect(parseServers('gtnh,smp')).toEqual(['smp', 'gtnh']);
    expect(narrowed('smp,gtnh')).toBe(false);
    expect(narrowed('gtnh')).toBe(true);
    expect(serversLabel('gtnh')).toBe('GT:NH modpack');
  });

  it('a friend waits for the board, then goes on the servers or away', async () => {
    await setOwnMinecraftName(db(), 'm1', 'Alex', NOW, mojang);
    expect((await addMinecraftFriend(db(), 'm1', 'Friend1', NOW, mojang)).approved).toBe(false);
    await addMinecraftFriend(db(), 'm1', 'Friend2', NOW + 1, mojang, 'gtnh');
    expect(await whitelistNames(db())).toEqual(['Alex']);
    expect((await listPendingFriends(db())).map((n) => [n.name, n.by_name, n.member_current])).toEqual([['Friend1', null, 1], ['Friend2', null, 1]]);
    expect((await listMinecraftNames(db(), 'm1')).map((n) => n.approved_at)).toEqual([NOW, null, null]);
    expect((await approveMinecraftName(db(), 'friend1', 'board', NOW + 5))?.approved_by).toBe('board');
    expect(await approveMinecraftName(db(), 'friend1', 'board', NOW + 5)).toBeNull();
    expect((await declineMinecraftName(db(), 'Friend2'))?.discord_id).toBe('m1');
    expect(await declineMinecraftName(db(), 'Friend2')).toBeNull();
    expect(await whitelistNames(db())).toEqual(['Alex', 'Friend1']);
    expect((await listAllMinecraftNames(db())).map((n) => n.name)).toEqual(['Alex', 'Friend1']);
    expect(friendRequestLine('Axi', 'Friend1', '', 'https://x')).toContain('asks to whitelist **Friend1** (a friend) on every server');
    expect(friendRequestLine('Axi', 'Friend1', 'gtnh', 'https://x')).toContain('on GT:NH modpack only');
  });

  it('dashes a Mojang id', () => {
    expect(dashedUuid('069A79F444E94726A5BEFCA90E38AAF5')).toBe('069a79f4-44e9-4726-a5be-fca90e38aaf5');
  });

  it('checks the bearer token without a length or prefix shortcut', () => {
    expect(bearerToken(new Request('https://x', { headers: { authorization: 'Bearer abc' } }))).toBe('abc');
    expect(bearerToken(new Request('https://x', { headers: { authorization: 'bearer  abc' } }))).toBe('abc');
    expect(bearerToken(new Request('https://x', { headers: { authorization: 'Basic abc' } }))).toBeNull();
    expect(bearerToken(new Request('https://x'))).toBeNull();
    expect(tokenMatches('secret', 'secret')).toBe(true);
    expect(tokenMatches('secret', 'secret2')).toBe(false);
    expect(tokenMatches('secre', 'secret')).toBe(false);
    expect(tokenMatches(null, 'secret')).toBe(false);
    expect(tokenMatches('secret', undefined)).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });
});
