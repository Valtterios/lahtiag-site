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
  tokenMatches,
  bearerToken,
  FRIENDS_PER_MEMBER,
} from '../src/lib/minecraft';

// The Minecraft whitelist: a member's own name and friends, board names,
// and what the server gets to see.

const NOW = 1_760_000_000;
const db = () => env.DB;

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
    expect(await setOwnMinecraftName(db(), 'm1', ' Steve ', NOW)).toBe('Steve');
    expect(await setOwnMinecraftName(db(), 'm1', 'Steve_2', NOW + 1)).toBe('Steve_2');
    expect((await listMinecraftNames(db(), 'm1')).map((n) => [n.name, n.kind])).toEqual([['Steve_2', 'own']]);
    await expect(setOwnMinecraftName(db(), 'm1', 'no spaces here', NOW)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(setOwnMinecraftName(db(), 'm1', 'ab', NOW)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(setOwnMinecraftName(db(), 'p1', 'Pending', NOW)).rejects.toMatchObject({ code: 'not_member' });
    await expect(setOwnMinecraftName(db(), 'nobody', 'Ghost', NOW)).rejects.toMatchObject({ code: 'not_member' });
    // Someone else's name, in any case, is taken.
    await expect(setOwnMinecraftName(db(), 'm2', 'steve_2', NOW)).rejects.toMatchObject({ code: 'name_taken' });
  });

  it('brings friends up to the limit, and a friend promoted to own stays one row', async () => {
    await setOwnMinecraftName(db(), 'm1', 'Alex', NOW);
    await addMinecraftFriend(db(), 'm1', 'Friend1', NOW);
    await addMinecraftFriend(db(), 'm1', 'Friend2', NOW);
    expect(FRIENDS_PER_MEMBER).toBe(2);
    await expect(addMinecraftFriend(db(), 'm1', 'Friend3', NOW)).rejects.toMatchObject({ code: 'friend_limit' });
    await expect(addMinecraftFriend(db(), 'm2', 'friend1', NOW)).rejects.toMatchObject({ code: 'name_taken' });
    await expect(addMinecraftFriend(db(), 'p1', 'Nope', NOW)).rejects.toMatchObject({ code: 'not_member' });
    expect(await removeMinecraftName(db(), 'm1', 'Friend2')).toBe(true);
    expect(await removeMinecraftName(db(), 'm1', 'Friend2')).toBe(false);
    expect(await removeMinecraftName(db(), 'm2', 'Friend1')).toBe(false); // not theirs
    await setOwnMinecraftName(db(), 'm1', 'friend1', NOW + 5);
    expect((await listMinecraftNames(db(), 'm1')).map((n) => [n.name, n.kind])).toEqual([['friend1', 'own']]);
  });

  it('lists board names always and members’ names while they are current', async () => {
    await setOwnMinecraftName(db(), 'm1', 'Alex', NOW);
    await addMinecraftFriend(db(), 'm1', 'Buddy', NOW);
    await setOwnMinecraftName(db(), 'm2', 'Zed', NOW);
    await addBoardMinecraftName(db(), 'board', 'Guest', NOW);
    await expect(addBoardMinecraftName(db(), 'board', 'guest', NOW)).rejects.toMatchObject({ code: 'name_taken' });
    expect(await whitelistNames(db())).toEqual(['Alex', 'Buddy', 'Guest', 'Zed']);
    await db().prepare(`UPDATE register SET status = 'former' WHERE discord_id = 'm1'`).run();
    expect(await whitelistNames(db())).toEqual(['Guest', 'Zed']);
    // A seeded board name is claimable by a member, as their own or as a friend; then it follows them.
    await addBoardMinecraftName(db(), 'board', 'Seeded', NOW);
    await addBoardMinecraftName(db(), 'board', 'Seeded2', NOW);
    expect(await setOwnMinecraftName(db(), 'm2', 'seeded', NOW + 1)).toBe('seeded');
    expect(await addMinecraftFriend(db(), 'm2', 'Seeded2', NOW + 1)).toBe('Seeded2');
    // Their previous own name (Zed) went with the claim; the claimed names are theirs now.
    expect((await listMinecraftNames(db(), 'm2')).map((n) => [n.name, n.kind])).toEqual([['seeded', 'own'], ['Seeded2', 'friend']]);
    expect(await whitelistNames(db())).toEqual(['Guest', 'seeded', 'Seeded2']);
    await expect(setOwnMinecraftName(db(), 'p1', 'Guest', NOW)).rejects.toMatchObject({ code: 'not_member' });
    await expect(setOwnMinecraftName(db(), 'm3', 'Seeded2', NOW)).rejects.toMatchObject({ code: 'name_taken' });
    await expect(addMinecraftFriend(db(), 'm3', 'seeded', NOW)).rejects.toMatchObject({ code: 'name_taken' });
    // The board drops any name; a member cannot take a board name off.
    expect(await removeMinecraftName(db(), 'board', 'Guest')).toBe(false);
    expect((await dropMinecraftName(db(), 'guest'))?.kind).toBe('board');
    expect((await dropMinecraftName(db(), 'seeded'))?.discord_id).toBe('m2');
    expect(await dropMinecraftName(db(), 'Zed')).toBeNull();
    expect(await whitelistNames(db())).toEqual(['Seeded2']);
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
