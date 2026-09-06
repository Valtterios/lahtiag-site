import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  setSignup,
  getEvent,
  getBracket,
  generateBracket,
  setBracketSeeding,
  goLiveBracket,
  replaceBracketParticipant,
  renameEventTeam,
  adminCreateTeam,
  setBracketWinner,
} from '../src/lib/db';

// The board's hand on the draw: a draft first, reseeding, going live,
// substitutes, and team names.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['bracket_matches', 'signups', 'event_teams', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
}
async function seedSolo(players: string[]): Promise<number> {
  await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
  const id = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'host' }, NOW);
  for (const p of players) {
    await upsertMember(db(), { discord_id: p, username: `player ${p}`, avatar_hash: null }, NOW);
    await setSignup(db(), id, p, 'yes', NOW);
  }
  return id;
}

describe('draft, seeding and going live', () => {
  beforeEach(wipe);

  it('draws a draft, takes a new seeding, then goes live once', async () => {
    const id = await seedSolo(['1', '2', '3', '4']);
    await generateBracket(db(), id, NOW);
    expect((await getEvent(db(), id))?.bracket_live_at).toBeNull();
    const before = (await getBracket(db(), id)).filter((m) => m.round === 1);
    // Swap the two matches' first sides.
    await setBracketSeeding(db(), id, [
      [before[1].side_a, before[0].side_b],
      [before[0].side_a, before[1].side_b],
    ]);
    const after = (await getBracket(db(), id)).filter((m) => m.round === 1);
    expect(after[0].side_a).toBe(before[1].side_a);
    expect(after[1].side_a).toBe(before[0].side_a);
    expect(await goLiveBracket(db(), id, NOW + 10)).toBe(true);
    expect((await getEvent(db(), id))?.bracket_live_at).toBe(NOW + 10);
    expect(await goLiveBracket(db(), id, NOW + 20)).toBe(false);
    await expect(setBracketSeeding(db(), id, [[before[0].side_a, before[0].side_b], [before[1].side_a, before[1].side_b]])).rejects.toMatchObject({ code: 'bracket_live' });
    // A redraw is a draft again.
    await generateBracket(db(), id, NOW + 30);
    expect((await getEvent(db(), id))?.bracket_live_at).toBeNull();
  });

  it('keeps byes, and refuses a seeding that drops or doubles anyone', async () => {
    const id = await seedSolo(['1', '2', '3']);
    await generateBracket(db(), id, NOW);
    const first = (await getBracket(db(), id)).filter((m) => m.round === 1);
    expect(first.length).toBe(2);
    const [pair, lone] = first;
    // Move the bye to the other match; an empty first side is normalised.
    await setBracketSeeding(db(), id, [
      [null, lone.side_a],
      [pair.side_a, pair.side_b],
    ]);
    const re = await getBracket(db(), id);
    expect(re.find((m) => m.round === 1 && m.slot === 0)).toMatchObject({ side_a: lone.side_a, side_b: null, winner: lone.side_a });
    expect(re.find((m) => m.round === 2)?.side_a).toBe(lone.side_a);
    await expect(setBracketSeeding(db(), id, [[pair.side_a, pair.side_a], [lone.side_a, null]])).rejects.toMatchObject({ code: 'bad_seeding' });
    await expect(setBracketSeeding(db(), id, [[pair.side_a, pair.side_b], [null, null]])).rejects.toMatchObject({ code: 'bad_seeding' });
    await expect(setBracketSeeding(db(), id, [[pair.side_a, pair.side_b]])).rejects.toMatchObject({ code: 'bad_seeding' });
  });
});

describe('substitutes and team names', () => {
  beforeEach(wipe);

  it('swaps a participant everywhere, results included, only for someone on the roster', async () => {
    const id = await seedSolo(['1', '2', '3', '4']);
    await generateBracket(db(), id, NOW);
    const first = (await getBracket(db(), id)).filter((m) => m.round === 1)[0];
    await setBracketWinner(db(), id, 1, 0, first.side_a!);
    await upsertMember(db(), { discord_id: '5', username: 'player 5', avatar_hash: null }, NOW);
    await expect(replaceBracketParticipant(db(), id, first.side_a!, 'u:5')).rejects.toMatchObject({ code: 'bad_input' });
    await setSignup(db(), id, '5', 'yes', NOW);
    await replaceBracketParticipant(db(), id, first.side_a!, 'u:5');
    const after = await getBracket(db(), id);
    expect(after.find((m) => m.round === 1 && m.slot === 0)).toMatchObject({ side_a: 'u:5', winner: 'u:5' });
    expect(after.find((m) => m.round === 2)?.side_a).toBe('u:5');
    expect(after.some((m) => [m.side_a, m.side_b, m.winner].includes(first.side_a))).toBe(false);
    await expect(replaceBracketParticipant(db(), id, 'u:nobody', 'u:5')).rejects.toMatchObject({ code: 'missing' });
    await expect(replaceBracketParticipant(db(), id, 'u:5', first.side_b!)).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('renames a team, refusing a name another team has', async () => {
    await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
    const id = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, team_size: 2, created_by: 'host' }, NOW);
    const a = await adminCreateTeam(db(), id, 'Alpha', 'host', NOW);
    await adminCreateTeam(db(), id, 'Bravo', 'host', NOW);
    await renameEventTeam(db(), id, a, ' Alpha Prime ');
    expect((await db().prepare('SELECT name FROM event_teams WHERE id = ?1').bind(a).first<{ name: string }>())?.name).toBe('Alpha Prime');
    await expect(renameEventTeam(db(), id, a, 'bravo')).rejects.toMatchObject({ code: 'dup_name' });
    await expect(renameEventTeam(db(), id, a, '')).rejects.toMatchObject({ code: 'bad_input' });
    await expect(renameEventTeam(db(), id, 999, 'X')).rejects.toMatchObject({ code: 'missing' });
  });
});
