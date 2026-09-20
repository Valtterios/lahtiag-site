import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  setSignup,
  addBracket,
  getBracket,
  getBracketRow,
  setBracketFormat,
  setBracketWinner,
  RuleError,
} from '../src/lib/db';
import {
  applyCS2Event,
  bracketUpdateFor,
  buildMatchConfig,
  cancelCS2Match,
  getCS2Match,
  isFreshMap,
  isUsableMatchId,
  MATCHID_MAX,
  parseEvent,
  sendMatchToServer,
  activeCS2Matches,
  queuedMatches,
  markMatchSent,
  CS2_MAPPOOL,
} from '../src/lib/cs2';

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['cs2_matches', 'bracket_matches', 'brackets', 'signups', 'events', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function cupOfFour(bestOf = 3): Promise<{ eventId: number; bracketId: number }> {
  for (const id of ['admin', 'a', 'b', 'c', 'd']) {
    await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
  }
  const eventId = await createEvent(
    db(),
    { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'admin' },
    NOW,
  );
  for (const id of ['a', 'b', 'c', 'd']) await setSignup(db(), eventId, id, 'yes', NOW);
  const bracketId = await addBracket(db(), eventId, null, NOW, ['u:a', 'u:b', 'u:c', 'u:d']);
  if (bestOf !== 1) await setBracketFormat(db(), bracketId, bestOf, null);
  return { eventId, bracketId };
}

// Put round 1 slot 0 onto a server and hand back the matchid.
async function send(bracketId: number, server = '1', round = 1, slot = 0): Promise<number> {
  return (await sendFull(bracketId, server, round, slot)).id;
}

// The draw decides which participant lands on side A, so tests read it back
// rather than assuming an order.
async function sendFull(bracketId: number, server = '1', round = 1, slot = 0) {
  const bracket = (await getBracketRow(db(), bracketId))!;
  const matches = await getBracket(db(), bracketId);
  const match = matches.find((m) => m.round === round && m.slot === slot)!;
  const totalRounds = matches.reduce((max, m) => Math.max(max, m.round), 0);
  return sendMatchToServer(db(), bracket, match, totalRounds, server, { a: 'heat', b: 'Turbiini' }, NOW);
}

const slotOf = async (bracketId: number, round = 1, slot = 0) =>
  (await getBracket(db(), bracketId)).find((m) => m.round === round && m.slot === slot)!;

const mapResult = (matchid: number, mapNumber: number, a: number, b: number) => ({
  event: 'map_result',
  matchid,
  map_number: mapNumber,
  winner: { side: 'ct', team: a > b ? 'team1' : 'team2' },
  team1: { series_score: a, score: 13, score_ct: 7, score_t: 6, players: [] },
  team2: { series_score: b, score: 9, score_ct: 5, score_t: 4, players: [] },
});

beforeEach(wipe);

// ---------------------------------------------------------------------------

describe('the match config a server pulls', () => {
  it('ships both rosters EMPTY, which is what kicks nobody', async () => {
    // A MatchZy roster kicks every connected player missing from it, so a
    // partial roster kicks the players it forgot and one empty roster beside
    // a full one kicks that whole team. It emptied a live server once.
    const cfg = buildMatchConfig({ id: 7, best_of: 3, name_a: 'heat', name_b: 'Turbiini' });
    expect(cfg.team1.players).toEqual({});
    expect(cfg.team2.players).toEqual({});
  });

  it('names the teams for the scoreboard, team1 first', () => {
    const cfg = buildMatchConfig({ id: 7, best_of: 3, name_a: 'heat', name_b: 'Turbiini' });
    expect(cfg.team1.name).toBe('heat');
    expect(cfg.team2.name).toBe('Turbiini');
  });

  it('offers the whole pool and lets the server run the veto', () => {
    const cfg = buildMatchConfig({ id: 7, best_of: 3, name_a: 'x', name_b: 'y' });
    expect(cfg.skip_veto).toBe(false);
    expect(cfg.maplist).toEqual([...CS2_MAPPOOL]);
  });

  it('pins the pistol-round economy, which warmup.cfg otherwise resets', () => {
    const cfg = buildMatchConfig({ id: 7, best_of: 1, name_a: 'x', name_b: 'y' });
    expect(cfg.cvars.mp_startmoney).toBe('800');
    expect(cfg.cvars.mp_starting_losses).toBe('0');
  });

  it('sends the matchid as a string of digits', () => {
    expect(buildMatchConfig({ id: 42, best_of: 1, name_a: 'x', name_b: 'y' }).matchid).toBe('42');
  });

  it('refuses a best-of the servers cannot run', () => {
    expect(() => buildMatchConfig({ id: 1, best_of: 2, name_a: 'x', name_b: 'y' })).toThrow(RuleError);
    expect(() => buildMatchConfig({ id: 1, best_of: 7, name_a: 'x', name_b: 'y' })).toThrow(RuleError);
  });
});

describe('matchid fits in an int32', () => {
  // MatchZy parses matchid as a 32-bit SIGNED int and answers "matchid
  // should be an integer!" to anything bigger. A YYMMDDHHMM stamp
  // (2609192112) is all digits, is 2.6 billion, and is refused — verified
  // against a live server. The row id is used instead precisely because a
  // counter cannot reach the limit.
  it('accepts the boundary and rejects past it', () => {
    expect(isUsableMatchId(MATCHID_MAX)).toBe(true);
    expect(isUsableMatchId(MATCHID_MAX + 1)).toBe(false);
    expect(isUsableMatchId(2_609_192_112)).toBe(false);
  });

  it('rejects zero, negatives and fractions', () => {
    for (const bad of [0, -1, 1.5, NaN]) expect(isUsableMatchId(bad)).toBe(false);
  });
});

describe('reading events off the wire', () => {
  it('reads a map result, taking the SERIES score not the round score', () => {
    const event = parseEvent(mapResult(5, 1, 1, 0));
    expect(event).toMatchObject({ kind: 'map_result', matchid: 5, mapNumber: 1, seriesA: 1, seriesB: 0 });
  });

  it('reads series_end and maps team1/team2 onto side a/b', () => {
    expect(
      parseEvent({ event: 'series_end', matchid: 5, time_until_restore: 10, winner: { side: 'ct', team: 'team2' }, team1_series_score: 1, team2_series_score: 2 }),
    ).toMatchObject({ kind: 'series_end', winner: 'b', seriesA: 1, seriesB: 2 });
  });

  it('reads going_live and round_end', () => {
    expect(parseEvent({ event: 'going_live', matchid: 5, map_number: 0 })).toMatchObject({ kind: 'going_live' });
    expect(
      parseEvent({ event: 'round_end', matchid: 5, map_number: 0, round_number: 7, reason: 1, winner: { side: 'ct', team: 'team1' }, team1: { score: 4 }, team2: { score: 3 } }),
    ).toMatchObject({ kind: 'round_end', roundsA: 4, roundsB: 3 });
  });

  it('ignores the events we do not act on rather than failing', () => {
    // The plugin sends kills, grenades and demo progress too. An unknown
    // event is normal traffic, not an error.
    for (const body of [
      { event: 'player_death', matchid: 5 },
      { event: 'map_result' }, // no matchid
      { event: 'series_end', matchid: 5 }, // no scores
      'not an object',
      null,
      {},
    ]) {
      expect(parseEvent(body)).toBeNull();
    }
  });
});

describe('sending a match to a server', () => {
  it('records the sides and names as they stood', async () => {
    const { bracketId } = await cupOfFour();
    const drawn = await slotOf(bracketId);
    const id = await send(bracketId);
    const row = (await getCS2Match(db(), id))!;
    expect(row.status).toBe('pending');
    expect(row.name_a).toBe('heat');
    expect(row.best_of).toBe(3);
    // The sides are frozen as they stood, so a later bracket edit cannot
    // change who the server is reporting about.
    expect(row.side_a).toBe(drawn.side_a);
    expect(row.side_b).toBe(drawn.side_b);
  });

  it('will not put two matches on one server', async () => {
    const { bracketId } = await cupOfFour();
    await send(bracketId, '1', 1, 0);
    await expect(send(bracketId, '1', 1, 1)).rejects.toThrow(/Server 1 already has a match/);
  });

  it('will not send one match to two servers', async () => {
    const { bracketId } = await cupOfFour();
    await send(bracketId, '1', 1, 0);
    await expect(send(bracketId, '2', 1, 0)).rejects.toThrow(/already on a server/);
  });

  it('frees the server once the attempt is withdrawn', async () => {
    const { bracketId } = await cupOfFour();
    const id = await send(bracketId, '1', 1, 0);
    await cancelCS2Match(db(), id, NOW);
    await expect(send(bracketId, '1', 1, 1)).resolves.toBeGreaterThan(0);
  });

  it('refuses a match whose sides are not both known', async () => {
    const { bracketId } = await cupOfFour();
    const bracket = (await getBracketRow(db(), bracketId))!;
    const matches = await getBracket(db(), bracketId);
    const final = matches.find((m) => m.round === 2)!;
    await expect(
      sendMatchToServer(db(), bracket, final, 2, '1', { a: 'x', b: 'y' }, NOW),
    ).rejects.toThrow(RuleError);
  });

  it('refuses an unknown server', async () => {
    const { bracketId } = await cupOfFour();
    const bracket = (await getBracketRow(db(), bracketId))!;
    const match = (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
    await expect(
      sendMatchToServer(db(), bracket, match, 2, '3', { a: 'x', b: 'y' }, NOW),
    ).rejects.toThrow(RuleError);
  });

  it('lists what is on the servers right now', async () => {
    const { bracketId } = await cupOfFour();
    await send(bracketId, '1', 1, 0);
    await send(bracketId, '2', 1, 1);
    expect((await activeCS2Matches(db())).map((r) => r.server)).toEqual(['1', '2']);
  });
});

describe('a best-of-three played out', () => {
  it('follows the series into the bracket map by map, then advances it', async () => {
    const { bracketId } = await cupOfFour(3);
    const sideA = (await slotOf(bracketId)).side_a!;
    const id = await send(bracketId);

    await applyCS2Event(db(), parseEvent({ event: 'going_live', matchid: id, map_number: 0 })!, NOW);
    expect((await getCS2Match(db(), id))!.status).toBe('live');

    // Map 1 to heat: 1-0, nothing decided.
    await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    let match = (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
    expect([match.score_a, match.score_b]).toEqual([1, 0]);
    expect(match.winner).toBeNull();

    // Map 2 to Turbiini: 1-1.
    await applyCS2Event(db(), parseEvent(mapResult(id, 1, 1, 1))!, NOW);
    match = (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
    expect([match.score_a, match.score_b]).toEqual([1, 1]);
    expect(match.winner).toBeNull();

    // Map 3 to heat: 2-1 wins it, and the bracket advances by itself.
    await applyCS2Event(db(), parseEvent(mapResult(id, 2, 2, 1))!, NOW);
    match = (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
    expect(match.winner).toBe(sideA);
    expect([match.score_a, match.score_b]).toEqual([2, 1]);
    const final = (await getBracket(db(), bracketId)).find((m) => m.round === 2)!;
    expect([final.side_a, final.side_b]).toContain(sideA);
  });

  it('marks the attempt done at series_end', async () => {
    const { bracketId } = await cupOfFour(3);
    const id = await send(bracketId);
    await applyCS2Event(db(), parseEvent(mapResult(id, 0, 2, 0))!, NOW);
    await applyCS2Event(
      db(),
      parseEvent({ event: 'series_end', matchid: id, time_until_restore: 10, winner: { side: 'ct', team: 'team1' }, team1_series_score: 2, team2_series_score: 0 })!,
      NOW,
    );
    expect((await getCS2Match(db(), id))!.status).toBe('done');
  });
});

describe('a best-of-one', () => {
  it('is recorded as a win, because there are no games to count', async () => {
    // setBracketGames refuses a best-of-one by design: 1-0 of a best-of-one
    // is not a running score, it is the result.
    const { bracketId } = await cupOfFour(1);
    const sideA = (await slotOf(bracketId)).side_a!;
    const id = await send(bracketId);
    await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    expect((await slotOf(bracketId)).winner).toBe(sideA);
  });

  it('decides nothing from a 0-0', () => {
    expect(bracketUpdateFor(1, 0, 0)).toBeNull();
  });
});

describe('redelivery', () => {
  // MatchZy keeps a retry queue: anything answered with an error comes back,
  // and so can a delivery whose reply was lost. Map 1 arriving again after
  // map 2 would walk the bracket backwards.
  it('ignores a map result older than the one already recorded', async () => {
    const { bracketId } = await cupOfFour(3);
    const id = await send(bracketId);
    await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    await applyCS2Event(db(), parseEvent(mapResult(id, 1, 1, 1))!, NOW);

    const again = await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    expect(again.applied).toBe('stale_map');
    const match = (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
    expect([match.score_a, match.score_b]).toEqual([1, 1]);
  });

  it('knows which map numbers are new', () => {
    expect(isFreshMap({ last_map_number: null }, 0)).toBe(true);
    expect(isFreshMap({ last_map_number: 1 }, 1)).toBe(false);
    expect(isFreshMap({ last_map_number: 1 }, 2)).toBe(true);
  });

  it('does not mind the same map result twice in a row', async () => {
    const { bracketId } = await cupOfFour(3);
    const id = await send(bracketId);
    await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    const match = (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
    expect([match.score_a, match.score_b]).toEqual([1, 0]);
  });
});

describe('a server that keeps talking after we stopped listening', () => {
  it('cannot write to the bracket once the attempt is withdrawn', async () => {
    const { bracketId } = await cupOfFour(3);
    const id = await send(bracketId);
    await cancelCS2Match(db(), id, NOW);
    const result = await applyCS2Event(db(), parseEvent(mapResult(id, 0, 2, 0))!, NOW);
    expect(result.applied).toBe('ignored');
    const match = (await getBracket(db(), bracketId)).find((m) => m.round === 1 && m.slot === 0)!;
    expect(match.winner).toBeNull();
  });

  it('accepts an event for a matchid it has never heard of', async () => {
    expect((await applyCS2Event(db(), parseEvent(mapResult(999, 0, 1, 0))!, NOW)).applied).toBe('unknown_match');
  });

  it('does not fight the board over a match they already recorded by hand', async () => {
    // The board decides; the server reports. If the two disagree the write
    // is refused and the delivery is still accepted, or the server retries
    // it for the rest of the evening.
    const { bracketId } = await cupOfFour(3);
    const sideB = (await slotOf(bracketId)).side_b!;
    const id = await send(bracketId);
    await setBracketWinner(db(), bracketId, 1, 0, sideB, [2, 0]);
    const result = await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    expect(result.detail).toBe('board_decided');
    expect((await slotOf(bracketId)).winner).toBe(sideB); // the board's result stands
    expect((await slotOf(bracketId)).score_a).toBe(0);
  });
});

describe('the attempt may still correct its own result', () => {
  it('lets series_end confirm the win it already recorded', async () => {
    const { bracketId } = await cupOfFour(3);
    const sideA = (await slotOf(bracketId)).side_a!;
    const id = await send(bracketId);
    await applyCS2Event(db(), parseEvent(mapResult(id, 0, 1, 0))!, NOW);
    await applyCS2Event(db(), parseEvent(mapResult(id, 1, 2, 0))!, NOW);
    expect((await slotOf(bracketId)).winner).toBe(sideA);

    const end = await applyCS2Event(
      db(),
      parseEvent({ event: 'series_end', matchid: id, time_until_restore: 10, winner: { side: 'ct', team: 'team1' }, team1_series_score: 2, team2_series_score: 0 })!,
      NOW,
    );
    expect(end.detail).not.toBe('board_decided');
    const match = await slotOf(bracketId);
    expect(match.winner).toBe(sideA);
    expect([match.score_a, match.score_b]).toEqual([2, 0]);
  });

  it('records rounds as they are played without touching the bracket', async () => {
    const { bracketId } = await cupOfFour(3);
    const id = await send(bracketId);
    await applyCS2Event(
      db(),
      parseEvent({ event: 'round_end', matchid: id, map_number: 0, round_number: 7, reason: 1, winner: { side: 'ct', team: 'team1' }, team1: { score: 4 }, team2: { score: 3 } })!,
      NOW,
    );
    const row = (await getCS2Match(db(), id))!;
    expect([row.rounds_a, row.rounds_b]).toEqual([4, 3]);
    expect((await slotOf(bracketId)).winner).toBeNull();
  });
});

describe('the queue the AMP-host bridge drains', () => {
  it('offers a match once and only once', async () => {
    // matchzy_loadmatch over an autostarted live match destroys it silently.
    // A queue that kept re-offering the same match would wreck a game every
    // time the bridge polled.
    const { bracketId } = await cupOfFour(3);
    const id = await send(bracketId);
    expect((await queuedMatches(db())).map((r) => r.id)).toEqual([id]);

    expect(await markMatchSent(db(), id, NOW)).toBe(true);
    expect(await markMatchSent(db(), id, NOW)).toBe(false);
    expect(await queuedMatches(db())).toEqual([]);
  });

  it('does not offer a withdrawn match', async () => {
    const { bracketId } = await cupOfFour(3);
    const id = await send(bracketId);
    await cancelCS2Match(db(), id, NOW);
    expect(await queuedMatches(db())).toEqual([]);
    expect(await markMatchSent(db(), id, NOW)).toBe(false);
  });

  it('offers one match per server when both are in play', async () => {
    const { bracketId } = await cupOfFour(3);
    await send(bracketId, '1', 1, 0);
    await send(bracketId, '2', 1, 1);
    expect((await queuedMatches(db())).map((r) => r.server)).toEqual(['1', '2']);
  });
});
