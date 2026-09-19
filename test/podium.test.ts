import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  setSignup,
  addBracket,
  getBracket,
  getBracketRow,
  setBracketWinner,
  setBracketBronze,
  clearBracketWinner,
  listResults,
  goLiveBracket,
  RuleError,
} from '../src/lib/db';
import { podiumOf, podiumLine, isBronzeMatch, semifinalLosers, BRONZE_SLOT } from '../src/lib/podium';
import type { BracketMatch } from '../src/lib/db';

// The third-place match and the podium it completes.

const NOW = 1_760_000_000;
const db = () => env.DB;
const m = (round: number, slot: number, a: string | null, b: string | null, winner: string | null = null): BracketMatch =>
  ({ bracket_id: 1, event_id: 1, round, slot, side_a: a, side_b: b, winner, score_a: null, score_b: null });

async function wipe(): Promise<void> {
  for (const t of ['bracket_matches', 'brackets', 'signups', 'events', 'members']) await db().prepare(`DELETE FROM ${t}`).run();
}

// Four players, drawn: two semifinals and a final.
async function drawFour(): Promise<number> {
  await upsertMember(db(), { discord_id: 'admin', username: 'admin', avatar_hash: null }, NOW);
  const eventId = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'admin' }, NOW);
  for (const id of ['a', 'b', 'c', 'd']) {
    await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
    await setSignup(db(), eventId, id, 'yes', NOW);
  }
  return addBracket(db(), eventId, null, NOW);
}

const at = async (bracket: number, round: number, slot: number) => (await getBracket(db(), bracket)).find((x) => x.round === round && x.slot === slot)!;

beforeEach(wipe);

describe('the podium', () => {
  it('is nothing until the final is decided', () => {
    const undecided = [m(1, 0, 'u:a', 'u:b', 'u:a'), m(1, 1, 'u:c', 'u:d', 'u:c'), m(2, 0, 'u:a', 'u:c')];
    expect(podiumOf(undecided)).toBeNull();
  });

  it('names first and second, and third only when it was played for', () => {
    const decided = [m(1, 0, 'u:a', 'u:b', 'u:a'), m(1, 1, 'u:c', 'u:d', 'u:c'), m(2, 0, 'u:a', 'u:c', 'u:a')];
    expect(podiumOf(decided)).toEqual({ gold: 'u:a', silver: 'u:c', bronze: null });

    // With a third-place match, still played: third is not yet a fact.
    const withBronze = [...decided, m(2, BRONZE_SLOT, 'u:b', 'u:d')];
    expect(podiumOf(withBronze)?.bronze).toBeNull();

    const played = [...decided, m(2, BRONZE_SLOT, 'u:b', 'u:d', 'u:d')];
    expect(podiumOf(played)).toEqual({ gold: 'u:a', silver: 'u:c', bronze: 'u:d' });
  });

  it('tells the third-place match from the final beside it', () => {
    expect(isBronzeMatch({ round: 2, slot: 1 }, 2)).toBe(true);
    expect(isBronzeMatch({ round: 2, slot: 0 }, 2)).toBe(false);
    expect(isBronzeMatch({ round: 1, slot: 1 }, 2)).toBe(false);
    // A two-player bracket has no semifinals, so no slot 1 to be bronze.
    expect(isBronzeMatch({ round: 1, slot: 1 }, 1)).toBe(false);
  });

  it('reads the beaten semifinalists out of the semifinals', () => {
    const matches = [m(1, 0, 'u:a', 'u:b', 'u:a'), m(1, 1, 'u:c', 'u:d'), m(2, 0, 'u:a', null)];
    expect(semifinalLosers(matches, 2)).toEqual(['u:b', null]);
  });

  it('writes one line, naming the champion when asked', () => {
    const podium = { gold: 't:1', silver: 't:2', bronze: 't:3' };
    const nameOf = (k: string) => ({ 't:1': 'Alpha', 't:2': 'Bravo', 't:3': 'Charlie' })[k] ?? '?';
    expect(podiumLine(podium, nameOf)).toBe('🥇 **Alpha** · 🥈 Bravo · 🥉 Charlie');
    expect(podiumLine(podium, nameOf, true)).toBe('🥇 Champion: **Alpha** · 🥈 Bravo · 🥉 Charlie');
    expect(podiumLine({ ...podium, bronze: null }, nameOf)).toBe('🥇 **Alpha** · 🥈 Bravo');
  });
});

describe('the third-place match', () => {
  it('seats the beaten semifinalists as the semifinals are decided', async () => {
    const bracket = await drawFour();
    await setBracketBronze(db(), bracket, true);
    expect((await getBracketRow(db(), bracket))?.bronze).toBe(1);

    const semi0 = await at(bracket, 1, 0);
    await setBracketWinner(db(), bracket, 1, 0, semi0.side_a!);
    // One semifinal decided: one seat filled, the other still waiting.
    let bronze = await at(bracket, 2, BRONZE_SLOT);
    expect(bronze.side_a).toBe(semi0.side_b);
    expect(bronze.side_b).toBeNull();

    const semi1 = await at(bracket, 1, 1);
    await setBracketWinner(db(), bracket, 1, 1, semi1.side_a!);
    bronze = await at(bracket, 2, BRONZE_SLOT);
    expect([bronze.side_a, bronze.side_b]).toEqual([semi0.side_b, semi1.side_b]);
  });

  it('decides nothing about the title', async () => {
    const bracket = await drawFour();
    await setBracketBronze(db(), bracket, true);
    const semi0 = await at(bracket, 1, 0);
    const semi1 = await at(bracket, 1, 1);
    await setBracketWinner(db(), bracket, 1, 0, semi0.side_a!);
    await setBracketWinner(db(), bracket, 1, 1, semi1.side_a!);
    // Third place is played before the final here, as it often is.
    await setBracketWinner(db(), bracket, 2, BRONZE_SLOT, semi0.side_b!);
    expect(podiumOf(await getBracket(db(), bracket))).toBeNull(); // no champion yet

    await setBracketWinner(db(), bracket, 2, 0, semi0.side_a!);
    expect(podiumOf(await getBracket(db(), bracket))).toEqual({
      gold: semi0.side_a,
      silver: semi1.side_a,
      bronze: semi0.side_b,
    });
  });

  it('follows a semifinal that is reverted or re-recorded', async () => {
    const bracket = await drawFour();
    await setBracketBronze(db(), bracket, true);
    const semi0 = await at(bracket, 1, 0);
    const semi1 = await at(bracket, 1, 1);
    await setBracketWinner(db(), bracket, 1, 0, semi0.side_a!);
    await setBracketWinner(db(), bracket, 1, 1, semi1.side_a!);
    await setBracketWinner(db(), bracket, 2, BRONZE_SLOT, semi0.side_b!);

    // The board had the wrong winner in a semifinal: the loser it seated
    // is no longer a loser, and the third-place result cannot stand.
    await setBracketWinner(db(), bracket, 1, 0, semi0.side_b!);
    const bronze = await at(bracket, 2, BRONZE_SLOT);
    expect(bronze.side_a).toBe(semi0.side_a);
    expect(bronze.winner).toBeNull();

    // Reverting a semifinal empties its seat again.
    await clearBracketWinner(db(), bracket, 1, 1);
    expect((await at(bracket, 2, BRONZE_SLOT)).side_b).toBeNull();
  });

  it('is refused where there are no semifinals, and removable with its result', async () => {
    await upsertMember(db(), { discord_id: 'admin', username: 'admin', avatar_hash: null }, NOW);
    const eventId = await createEvent(db(), { title: 'Duel', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'admin' }, NOW);
    for (const id of ['a', 'b']) {
      await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
      await setSignup(db(), eventId, id, 'yes', NOW);
    }
    const duel = await addBracket(db(), eventId, null, NOW);
    await expect(setBracketBronze(db(), duel, true)).rejects.toThrow(RuleError);

    const bracket = await drawFour();
    await setBracketBronze(db(), bracket, true);
    expect(await at(bracket, 2, BRONZE_SLOT)).toBeTruthy();
    await setBracketBronze(db(), bracket, false);
    expect((await getBracket(db(), bracket)).find((x) => x.round === 2 && x.slot === BRONZE_SLOT)).toBeUndefined();
    expect((await getBracketRow(db(), bracket))?.bronze).toBe(0);
  });

  it('never counts as a second champion in the results archive', async () => {
    const bracket = await drawFour();
    await goLiveBracket(db(), bracket, NOW);
    await setBracketBronze(db(), bracket, true);
    const semi0 = await at(bracket, 1, 0);
    const semi1 = await at(bracket, 1, 1);
    await setBracketWinner(db(), bracket, 1, 0, semi0.side_a!);
    await setBracketWinner(db(), bracket, 1, 1, semi1.side_a!);
    await setBracketWinner(db(), bracket, 2, BRONZE_SLOT, semi0.side_b!);
    await setBracketWinner(db(), bracket, 2, 0, semi0.side_a!);

    const results = await listResults(db());
    expect(results).toHaveLength(1); // the champion, not the third-place winner too
    expect(results[0].champion_name).toBe(`user-${semi0.side_a!.slice(2)}`);
    expect(results[0].runner_up_name).toBe(`user-${semi1.side_a!.slice(2)}`);
    expect(results[0].third_name).toBe(`user-${semi0.side_b!.slice(2)}`);
  });
});
