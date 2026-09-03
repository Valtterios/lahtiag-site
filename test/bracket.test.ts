import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  createEventTeam,
  setSignup,
  setSignupsClosed,
  generateBracket,
  getBracket,
  setBracketWinner,
  clearBracketWinner,
  deleteBracket,
  deleteEvent,
  cancelEvent as cancelEventRow,
  listResults,
  getEvent,
  listSignups,
  RuleError,
} from '../src/lib/db';

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['bracket_matches', 'signups', 'event_teams', 'events', 'announcements', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function member(id: string): Promise<void> {
  await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
}

async function soloEventWith(playerIds: string[]): Promise<number> {
  await member('admin');
  const eventId = await createEvent(
    db(),
    { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'admin' },
    NOW,
  );
  for (const id of playerIds) {
    await member(id);
    await setSignup(db(), eventId, id, 'yes', NOW);
  }
  return eventId;
}

beforeEach(wipe);

describe('generateBracket', () => {
  it('builds one final from 4 players across 2 rounds', async () => {
    const eventId = await soloEventWith(['a', 'b', 'c', 'd']);
    await generateBracket(db(), eventId);
    const matches = await getBracket(db(), eventId);
    expect(matches.filter((m) => m.round === 1)).toHaveLength(2);
    expect(matches.filter((m) => m.round === 2)).toHaveLength(1);
    // every player placed exactly once in round 1
    const placed = matches
      .filter((m) => m.round === 1)
      .flatMap((m) => [m.side_a, m.side_b])
      .sort();
    expect(placed).toEqual(['u:a', 'u:b', 'u:c', 'u:d']);
  });

  it('gives byes that auto-advance when the field is not a power of two', async () => {
    const eventId = await soloEventWith(['a', 'b', 'c', 'd', 'e']);
    await generateBracket(db(), eventId);
    const matches = await getBracket(db(), eventId);
    const round1 = matches.filter((m) => m.round === 1);
    expect(round1).toHaveLength(4); // bracket of 8
    const byes = round1.filter((m) => m.side_b === null);
    expect(byes).toHaveLength(3);
    // each bye already has its winner recorded and advanced into round 2
    for (const bye of byes) {
      expect(bye.winner).toBe(bye.side_a);
    }
    const round2Sides = matches
      .filter((m) => m.round === 2)
      .flatMap((m) => [m.side_a, m.side_b])
      .filter(Boolean);
    expect(round2Sides.length).toBe(3);
  });

  it('uses teams as participants on a team event', async () => {
    await member('admin');
    await member('a');
    await member('b');
    const eventId = await createEvent(
      db(),
      {
        title: 'Doubles',
        description: null,
        starts_at: NOW + 86400,
        capacity: null,
        team_size: 2,
        created_by: 'admin',
      },
      NOW,
    );
    const t1 = await createEventTeam(db(), eventId, 'One', 'a', NOW);
    const t2 = await createEventTeam(db(), eventId, 'Two', 'b', NOW);
    await generateBracket(db(), eventId);
    const matches = await getBracket(db(), eventId);
    expect(matches).toHaveLength(1);
    expect([matches[0].side_a, matches[0].side_b].sort()).toEqual([`t:${t1}`, `t:${t2}`].sort());
  });

  it('refuses a bracket with fewer than two participants', async () => {
    const eventId = await soloEventWith(['a']);
    await expect(generateBracket(db(), eventId)).rejects.toMatchObject({ code: 'bad_input' });
  });
});

describe('setBracketWinner', () => {
  it('advances the winner into the next round and crowns a champion', async () => {
    const eventId = await soloEventWith(['a', 'b', 'c', 'd']);
    await generateBracket(db(), eventId);
    const round1 = (await getBracket(db(), eventId)).filter((m) => m.round === 1);
    await setBracketWinner(db(), eventId, 1, 0, round1[0].side_a!);
    await setBracketWinner(db(), eventId, 1, 1, round1[1].side_b!);
    let final = (await getBracket(db(), eventId)).find((m) => m.round === 2)!;
    expect(final.side_a).toBe(round1[0].side_a);
    expect(final.side_b).toBe(round1[1].side_b);
    await setBracketWinner(db(), eventId, 2, 0, final.side_a!);
    final = (await getBracket(db(), eventId)).find((m) => m.round === 2)!;
    expect(final.winner).toBe(round1[0].side_a);
  });

  it('changing an earlier result clears everything downstream of it', async () => {
    const eventId = await soloEventWith(['a', 'b', 'c', 'd']);
    await generateBracket(db(), eventId);
    const round1 = (await getBracket(db(), eventId)).filter((m) => m.round === 1);
    await setBracketWinner(db(), eventId, 1, 0, round1[0].side_a!);
    await setBracketWinner(db(), eventId, 1, 1, round1[1].side_a!);
    await setBracketWinner(db(), eventId, 2, 0, round1[0].side_a!); // champion
    // Now flip match 1's result.
    await setBracketWinner(db(), eventId, 1, 0, round1[0].side_b!);
    const final = (await getBracket(db(), eventId)).find((m) => m.round === 2)!;
    expect(final.side_a).toBe(round1[0].side_b);
    expect(final.winner).toBeNull();
  });

  it('rejects a winner that is not one of the sides or an unready match', async () => {
    const eventId = await soloEventWith(['a', 'b', 'c', 'd']);
    await generateBracket(db(), eventId);
    await expect(setBracketWinner(db(), eventId, 1, 0, 'u:zzz')).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(setBracketWinner(db(), eventId, 2, 0, 'u:a')).rejects.toMatchObject({
      code: 'bad_input',
    });
  });

  it('clearBracketWinner reverts a result and pulls the winner back out of later rounds', async () => {
    const eventId = await soloEventWith(['a', 'b', 'c', 'd']);
    await generateBracket(db(), eventId);
    const round1 = (await getBracket(db(), eventId)).filter((m) => m.round === 1);
    await setBracketWinner(db(), eventId, 1, 0, round1[0].side_a!);
    await setBracketWinner(db(), eventId, 1, 1, round1[1].side_a!);
    await setBracketWinner(db(), eventId, 2, 0, round1[0].side_a!); // champion
    await clearBracketWinner(db(), eventId, 1, 0);
    const after = await getBracket(db(), eventId);
    expect(after.find((m) => m.round === 1 && m.slot === 0)!.winner).toBeNull();
    const final = after.find((m) => m.round === 2)!;
    expect(final.side_a).toBeNull(); // the reverted winner is gone from the final
    expect(final.side_b).toBe(round1[1].side_a); // the other semifinal stands
    expect(final.winner).toBeNull();
  });

  it('clearBracketWinner is a no-op on an undecided match and rejects byes', async () => {
    const eventId = await soloEventWith(['a', 'b', 'c']);
    await generateBracket(db(), eventId);
    const round1 = (await getBracket(db(), eventId)).filter((m) => m.round === 1);
    const real = round1.find((m) => m.side_b !== null)!;
    const bye = round1.find((m) => m.side_b === null)!;
    await clearBracketWinner(db(), eventId, 1, real.slot); // undecided: no-op
    await expect(clearBracketWinner(db(), eventId, 1, bye.slot)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(clearBracketWinner(db(), eventId, 9, 9)).rejects.toMatchObject({
      code: 'missing',
    });
  });

  it('deleteBracket clears the chart', async () => {
    const eventId = await soloEventWith(['a', 'b']);
    await generateBracket(db(), eventId);
    await deleteBracket(db(), eventId);
    expect(await getBracket(db(), eventId)).toHaveLength(0);
  });
});

describe('results and deletion', () => {
  it('a decided final lands in results, unless the event is cancelled', async () => {
    const eventId = await soloEventWith(['a', 'b']);
    await generateBracket(db(), eventId);
    const match = (await getBracket(db(), eventId))[0];
    await setBracketWinner(db(), eventId, 1, 0, match.side_a!);
    expect((await listResults(db())).map((r) => r.event_id)).toContain(eventId);
    await cancelEventRow(db(), eventId, NOW);
    expect((await listResults(db())).map((r) => r.event_id)).not.toContain(eventId);
  });

  it('deleteEvent erases the event with signups and bracket', async () => {
    const eventId = await soloEventWith(['a', 'b']);
    await generateBracket(db(), eventId);
    await deleteEvent(db(), eventId);
    expect(await getEvent(db(), eventId)).toBeNull();
    expect(await getBracket(db(), eventId)).toHaveLength(0);
    expect(await listSignups(db(), eventId)).toHaveLength(0);
    await expect(deleteEvent(db(), eventId)).rejects.toMatchObject({ code: 'missing' });
  });
});

describe('closed signups', () => {
  it('blocks joining, changing, and removing once closed, and reopens cleanly', async () => {
    const eventId = await soloEventWith(['a']);
    await member('b');
    await setSignupsClosed(db(), eventId, true, NOW);
    await expect(setSignup(db(), eventId, 'b', 'yes', NOW)).rejects.toMatchObject({ code: 'closed' });
    await expect(setSignup(db(), eventId, 'a', 'maybe', NOW)).rejects.toMatchObject({ code: 'closed' });
    await setSignupsClosed(db(), eventId, false, NOW);
    await setSignup(db(), eventId, 'b', 'yes', NOW);
  });

  it('blocks team formation once closed', async () => {
    await member('admin');
    await member('a');
    const eventId = await createEvent(
      db(),
      {
        title: 'Doubles',
        description: null,
        starts_at: NOW + 86400,
        capacity: null,
        team_size: 2,
        created_by: 'admin',
      },
      NOW,
    );
    await setSignupsClosed(db(), eventId, true, NOW);
    await expect(createEventTeam(db(), eventId, 'Late', 'a', NOW)).rejects.toMatchObject({
      code: 'closed',
    });
  });

  it('bracket generation still works while signups are closed', async () => {
    const eventId = await soloEventWith(['a', 'b']);
    await setSignupsClosed(db(), eventId, true, NOW);
    await generateBracket(db(), eventId);
    expect(await getBracket(db(), eventId)).toHaveLength(1);
  });
});
