import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  setSignup,
  addBracket,
  createBracket,
  generateBracket,
  renameBracket,
  deleteBracket,
  deleteEvent,
  listBrackets,
  getBracket,
  getBracketRow,
  mainBracket,
  pickBracket,
  goLiveBracket,
  setBracketWinner,
  listResults,
  memberStats,
} from '../src/lib/db';

// One event, several draws: a main bracket and a plate, each named, each
// drawn from whoever the board picked, each going live on its own.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function cupWith(players: string[]): Promise<number> {
  await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
  const id = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'host' }, NOW);
  for (const p of players) {
    await upsertMember(db(), { discord_id: p, username: `player ${p}`, avatar_hash: null }, NOW);
    await setSignup(db(), id, p, 'yes', NOW);
  }
  return id;
}

describe('several brackets on one event', () => {
  beforeEach(async () => {
    for (const table of ['bracket_matches', 'brackets', 'signups', 'event_teams', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
  });

  it('names them, keeps them apart, and refuses a name twice', async () => {
    const cup = await cupWith(['a', 'b', 'c', 'd']);
    const main = await addBracket(db(), cup, null, NOW);
    const plate = await addBracket(db(), cup, 'Plate', NOW + 1, ['u:c', 'u:d']);
    expect((await listBrackets(db(), cup)).map((b) => b.name)).toEqual(['Main bracket', 'Plate']);
    expect(await getBracket(db(), main)).toHaveLength(3); // 4 players: two semifinals and a final
    expect(await getBracket(db(), plate)).toHaveLength(1);
    expect((await getBracket(db(), plate)).flatMap((m) => [m.side_a, m.side_b]).sort()).toEqual(['u:c', 'u:d']);
    // The event's "the bracket" is its first, and a stale ?b= falls back to it.
    expect((await mainBracket(db(), cup))?.id).toBe(main);
    expect((await pickBracket(db(), cup, plate))?.id).toBe(plate);
    expect((await pickBracket(db(), cup, 9999))?.id).toBe(main);
    expect((await pickBracket(db(), cup, null))?.id).toBe(main);
    await expect(addBracket(db(), cup, 'plate', NOW)).rejects.toMatchObject({ code: 'dup_name' });
    // A draw that cannot be made leaves nothing behind.
    await expect(addBracket(db(), cup, 'Ghosts', NOW, ['u:zzz'])).rejects.toMatchObject({ code: 'bad_input' });
    await expect(addBracket(db(), cup, 'Lonely', NOW, ['u:a'])).rejects.toMatchObject({ code: 'too_few' });
    expect(await listBrackets(db(), cup)).toHaveLength(2);
    // A nameless third takes the next number.
    const third = await addBracket(db(), cup, null, NOW + 2);
    expect((await getBracketRow(db(), third))?.name).toBe('Bracket 3');
    await renameBracket(db(), third, ' Group C ');
    expect((await getBracketRow(db(), third))?.name).toBe('Group C');
    await expect(renameBracket(db(), third, 'PLATE')).rejects.toMatchObject({ code: 'dup_name' });
  });

  it('goes live one at a time, and a result stays in its own draw', async () => {
    const cup = await cupWith(['a', 'b', 'c', 'd']);
    const main = await addBracket(db(), cup, 'Main', NOW);
    const plate = await addBracket(db(), cup, 'Plate', NOW + 1, ['u:c', 'u:d']);
    expect(await goLiveBracket(db(), plate, NOW + 5)).toBe(true);
    expect((await getBracketRow(db(), plate))?.live_at).toBe(NOW + 5);
    expect((await getBracketRow(db(), main))?.live_at).toBeNull();
    const plateFinal = (await getBracket(db(), plate))[0];
    await setBracketWinner(db(), plate, 1, 0, plateFinal.side_a!);
    // The main bracket is untouched by the plate's result.
    expect((await getBracket(db(), main)).every((m) => m.winner === null || m.side_b === null)).toBe(true);
    // Only the live one with a champion is a result, and it is named.
    const results = await listResults(db());
    expect(results.map((r) => [r.bracket_id, r.bracket_name])).toEqual([[plate, 'Plate']]);
    // Deleting the other leaves the plate as the event's only draw, and a
    // lone bracket needs no name in the archive.
    await deleteBracket(db(), main);
    expect(await listBrackets(db(), cup)).toHaveLength(1);
    expect((await listResults(db()))[0].bracket_name).toBeNull();
    expect(await getBracket(db(), main)).toHaveLength(0);
  });

  it('counts one tournament played however many draws it ran, and a trophy each', async () => {
    const cup = await cupWith(['a', 'b']);
    const first = await addBracket(db(), cup, 'One', NOW);
    const second = await addBracket(db(), cup, 'Two', NOW + 1);
    for (const bracket of [first, second]) {
      await goLiveBracket(db(), bracket, NOW + 2);
      await setBracketWinner(db(), bracket, 1, 0, 'u:a');
    }
    const later = NOW + 86400 * 2;
    expect(await memberStats(db(), 'a', later)).toMatchObject({ attended: 1, tournaments: 1, wins: 2 });
    expect(await memberStats(db(), 'b', later)).toMatchObject({ attended: 1, tournaments: 1, wins: 0 });
    expect((await listResults(db())).map((r) => r.bracket_name)).toEqual(['One', 'Two']);
  });

  it('an empty bracket can be made first and drawn after, and the event takes them all with it', async () => {
    const cup = await cupWith(['a', 'b']);
    const empty = await createBracket(db(), cup, 'Later', NOW);
    expect(await getBracket(db(), empty)).toHaveLength(0);
    await expect(goLiveBracket(db(), empty, NOW)).rejects.toMatchObject({ code: 'missing' });
    await generateBracket(db(), empty, NOW);
    expect(await getBracket(db(), empty)).toHaveLength(1);
    await deleteEvent(db(), cup);
    expect(await listBrackets(db(), cup)).toHaveLength(0);
    expect(await getBracket(db(), empty)).toHaveLength(0);
  });
});
