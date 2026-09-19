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
  setBracketFormat,
  setBracketGames,
  clearBracketWinner,
  RuleError,
} from '../src/lib/db';
import { bestOfFor, winsNeeded, scorelines, isLegalScore, scoreText, parseScore, sidesOf, isBestOf, isLiveScore, isRecordableScore, decidedBy } from '../src/lib/scores';

// Best-of matches: the rules themselves, then recording a scoreline
// against real D1.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['bracket_matches', 'brackets', 'signups', 'events', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function drawFour(): Promise<number> {
  await upsertMember(db(), { discord_id: 'admin', username: 'admin', avatar_hash: null }, NOW);
  const eventId = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'admin' }, NOW);
  for (const id of ['a', 'b', 'c', 'd']) {
    await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
    await setSignup(db(), eventId, id, 'yes', NOW);
  }
  return addBracket(db(), eventId, null, NOW);
}

// The round-one match of a freshly drawn bracket, whoever landed in it.
async function firstMatch(bracketId: number) {
  return (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
}

beforeEach(wipe);

describe('the rules of a best-of', () => {
  it('counts the games a side must win', () => {
    expect(winsNeeded(1)).toBe(1);
    expect(winsNeeded(3)).toBe(2);
    expect(winsNeeded(5)).toBe(3);
  });

  it('lists every way one can end, the sweep first', () => {
    expect(scorelines(3)).toEqual([
      [2, 0],
      [2, 1],
    ]);
    expect(scorelines(5)).toEqual([
      [3, 0],
      [3, 1],
      [3, 2],
    ]);
    expect(scorelines(1)).toEqual([[1, 0]]);
  });

  it('refuses a score the format cannot produce', () => {
    expect(isLegalScore(3, 2, 1)).toBe(true);
    expect(isLegalScore(3, 2, 2)).toBe(false); // nobody reaches 2 twice
    expect(isLegalScore(3, 3, 0)).toBe(false); // that is a best-of-five sweep
    expect(isLegalScore(5, 3, 2)).toBe(true);
  });

  it('plays the final longer than the rest when the board says so', () => {
    const bracket = { best_of: 3, final_best_of: 5 };
    expect(bestOfFor(bracket, 1, 3)).toBe(3);
    expect(bestOfFor(bracket, 2, 3)).toBe(3);
    expect(bestOfFor(bracket, 3, 3)).toBe(5); // the final
    // No override: every round is the bracket's own length.
    expect(bestOfFor({ best_of: 3, final_best_of: null }, 3, 3)).toBe(3);
    // An old bracket has no format at all and is best-of-one throughout.
    expect(bestOfFor({ best_of: 1, final_best_of: null }, 1, 1)).toBe(1);
  });

  it('only takes odd lengths, so a match cannot be drawn', () => {
    expect(isBestOf(3)).toBe(true);
    expect(isBestOf(2)).toBe(false);
    expect(isBestOf(0)).toBe(false);
    expect(isBestOf(11)).toBe(false);
  });

  it('reads and writes a scoreline', () => {
    expect(scoreText(2, 1)).toBe('2–1');
    expect(scoreText(null, null)).toBeNull();
    expect(scoreText(2, null)).toBeNull();
    expect(parseScore('2-1')).toEqual([2, 1]);
    expect(parseScore('2–1')).toEqual([2, 1]); // an en dash, as the bot writes it
    expect(parseScore(' 3 : 2 ')).toEqual([3, 2]);
    expect(parseScore('nonsense')).toBeNull();
    expect(parseScore(null)).toBeNull();
  });

  it('puts the games on the side that won them', () => {
    expect(sidesOf(true, [2, 1])).toEqual({ score_a: 2, score_b: 1 });
    expect(sidesOf(false, [2, 1])).toEqual({ score_a: 1, score_b: 2 });
    expect(sidesOf(true, null)).toEqual({ score_a: null, score_b: null });
  });
});

describe('recording a scoreline', () => {
  it('stores the games with the winner, and clears them on a revert', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 3, null);
    const match = await firstMatch(bracket);

    await setBracketWinner(db(), bracket, 1, 0, match.side_b!, [2, 1]);
    const after = await firstMatch(bracket);
    expect(after.winner).toBe(match.side_b);
    expect([after.score_a, after.score_b]).toEqual([1, 2]);

    await clearBracketWinner(db(), bracket, 1, 0);
    const reverted = await firstMatch(bracket);
    expect(reverted.winner).toBeNull();
    expect([reverted.score_a, reverted.score_b]).toEqual([null, null]);
  });

  it('corrects a scoreline without disturbing what followed', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 3, null);
    const match = await firstMatch(bracket);
    await setBracketWinner(db(), bracket, 1, 0, match.side_a!, [2, 0]);
    // The winner already stands in the final; correcting 2–0 to 2–1 must
    // not pull them back out of it.
    await setBracketWinner(db(), bracket, 1, 0, match.side_a!, [2, 1]);
    const after = await firstMatch(bracket);
    expect([after.score_a, after.score_b]).toEqual([2, 1]);
    expect((await getBracket(db(), bracket)).find((m) => m.round === 2)?.side_a).toBe(match.side_a);
  });

  it('refuses a score that does not fit the round, the final included', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 3, 5);
    const match = await firstMatch(bracket);
    // Round one is a best-of-three: 3–0 belongs to the final.
    await expect(setBracketWinner(db(), bracket, 1, 0, match.side_a!, [3, 0])).rejects.toThrow(RuleError);
    const untouched = await firstMatch(bracket);
    expect(untouched.winner).toBeNull();

    // The same score is right in the final, which is played to five.
    await setBracketWinner(db(), bracket, 1, 0, match.side_a!, [2, 0]);
    const second = (await getBracket(db(), bracket)).find((m) => m.round === 1 && m.slot === 1)!;
    await setBracketWinner(db(), bracket, 1, 1, second.side_a!, [2, 0]);
    await setBracketWinner(db(), bracket, 2, 0, match.side_a!, [3, 2]);
    const final = (await getBracket(db(), bracket)).find((m) => m.round === 2)!;
    expect(final.winner).toBe(match.side_a);
    expect(Math.max(final.score_a!, final.score_b!)).toBe(3);
  });

  it('records the winner alone when no score is given', async () => {
    const bracket = await drawFour();
    const match = await firstMatch(bracket);
    await setBracketWinner(db(), bracket, 1, 0, match.side_a!);
    const after = await firstMatch(bracket);
    expect(after.winner).toBe(match.side_a);
    expect([after.score_a, after.score_b]).toEqual([null, null]);
  });

  it('drops the scores a shortened format can no longer explain, keeping the winners', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 5, null);
    const match = await firstMatch(bracket);
    await setBracketWinner(db(), bracket, 1, 0, match.side_a!, [3, 2]);

    await setBracketFormat(db(), bracket, 3, null);
    const after = await firstMatch(bracket);
    expect(after.winner).toBe(match.side_a); // the result stands
    expect([after.score_a, after.score_b]).toEqual([null, null]); // 3–2 cannot happen in a best-of-three
    expect((await getBracketRow(db(), bracket))?.best_of).toBe(3);
  });

  it('keeps a score the new format still allows', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 3, null);
    const match = await firstMatch(bracket);
    await setBracketWinner(db(), bracket, 1, 0, match.side_a!, [2, 1]);
    // Only the final gets longer: round one is untouched, and so is its score.
    await setBracketFormat(db(), bracket, 3, 5);
    const after = await firstMatch(bracket);
    expect([after.score_a, after.score_b]).toEqual([2, 1]);
  });

  it('drops a score a longer format cannot produce either', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 5, null);
    const match = await firstMatch(bracket);
    await setBracketWinner(db(), bracket, 1, 0, match.side_a!, [3, 1]);
    // A best-of-seven is won at four games, so 3–1 no longer ends a match.
    await setBracketFormat(db(), bracket, 7, null);
    const after = await firstMatch(bracket);
    expect(after.winner).toBe(match.side_a);
    expect([after.score_a, after.score_b]).toEqual([null, null]);
  });

  it('refuses a format that is not an odd number of games', async () => {
    const bracket = await drawFour();
    await expect(setBracketFormat(db(), bracket, 2, null)).rejects.toThrow(RuleError);
    await expect(setBracketFormat(db(), bracket, 3, 4)).rejects.toThrow(RuleError);
  });
});

describe('following a match as it is played', () => {
  it('knows a score still in play from one that ends it', () => {
    // A best-of-three is won at two games.
    expect(isLiveScore(3, 1, 0)).toBe(true);
    expect(isLiveScore(3, 1, 1)).toBe(true);
    expect(isLiveScore(3, 2, 0)).toBe(false); // that is a win, not a state
    expect(isLiveScore(3, 0, 0)).toBe(false); // nothing played is nothing to show
    expect(decidedBy(3, 2, 1)).toBe('a');
    expect(decidedBy(3, 1, 2)).toBe('b');
    expect(decidedBy(3, 1, 1)).toBeNull();
    // Impossible states are neither.
    expect(isRecordableScore(3, 2, 2)).toBe(false);
    expect(isRecordableScore(3, 3, 0)).toBe(false);
    expect(isRecordableScore(3, 1, -1)).toBe(false);
    expect(isRecordableScore(5, 2, 2)).toBe(true);
  });

  it('records the games as they come, and the win with the last of them', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 3, null);
    const match = await firstMatch(bracket);

    // 1–0: the bracket shows who is ahead, and nobody has won.
    await setBracketGames(db(), bracket, 1, 0, 1, 0);
    let now = await firstMatch(bracket);
    expect([now.score_a, now.score_b]).toEqual([1, 0]);
    expect(now.winner).toBeNull();

    // 1–1, still anyone's.
    await setBracketGames(db(), bracket, 1, 0, 1, 1);
    now = await firstMatch(bracket);
    expect(now.winner).toBeNull();

    // The second game ends it: the win is recorded without a separate step.
    await setBracketGames(db(), bracket, 1, 0, 2, 1);
    now = await firstMatch(bracket);
    expect(now.winner).toBe(match.side_a);
    expect([now.score_a, now.score_b]).toEqual([2, 1]);
    // And the winner stands in the next round.
    expect((await getBracket(db(), bracket)).find((m) => m.round === 2)?.side_a).toBe(match.side_a);
  });

  it('takes a decided match back out of the later rounds when the score is corrected down', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 3, null);
    const match = await firstMatch(bracket);
    await setBracketGames(db(), bracket, 1, 0, 2, 0);
    expect((await getBracket(db(), bracket)).find((m) => m.round === 2)?.side_a).toBe(match.side_a);

    // It was 1–0, not 2–0: the match is being played again.
    await setBracketGames(db(), bracket, 1, 0, 1, 0);
    const after = await firstMatch(bracket);
    expect(after.winner).toBeNull();
    expect([after.score_a, after.score_b]).toEqual([1, 0]);
    expect((await getBracket(db(), bracket)).find((m) => m.round === 2)?.side_a).toBeNull();
  });

  it('refuses a score the format cannot stand at, and a best-of-one has no games', async () => {
    const bracket = await drawFour();
    await setBracketFormat(db(), bracket, 3, null);
    await expect(setBracketGames(db(), bracket, 1, 0, 2, 2)).rejects.toThrow(RuleError);
    await expect(setBracketGames(db(), bracket, 1, 0, 3, 0)).rejects.toThrow(RuleError);
    await setBracketFormat(db(), bracket, 1, null);
    await expect(setBracketGames(db(), bracket, 1, 0, 1, 0)).rejects.toThrow(RuleError);
  });
});
