import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parseProgressBatch, applyProgressBatch, tierOf, tierLabel, nextLine, progressBoard, progressByUuid, progressLine, progressBoardLines } from '../src/lib/gtnh';

// Where a player is in GT:NH: the tier from the quest book chapters, the
// snapshot applied once, the board sorted by tier.

const NOW = 1_760_000_000;
const AINO = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const PEKKA = '61699b2e-d327-4a01-9f1e-0ea8c3f06bc6';
const lines = (lv: number, mv = 0, hv = 0) => ({ stone: { done: 92, total: 92 }, steam: { done: 114, total: 114 }, lv: { done: lv, total: 155 }, mv: { done: mv, total: 146 }, hv: { done: hv, total: 115 } });

describe('GT:NH progress', () => {
  it('puts a player in the highest tier with a tenth of the chapter done', () => {
    expect(tierOf({})).toBeNull();
    expect(tierOf({ stone: { done: 0, total: 92 } })).toBeNull();
    expect(tierOf({ stone: { done: 9, total: 92 } })).toBeNull();
    expect(tierOf({ stone: { done: 10, total: 92 } })).toBe('stone');
    expect(tierOf(lines(15))).toBe('steam'); // 15 of 155 is short of 16
    expect(tierOf(lines(16))).toBe('lv');
    expect(tierOf(lines(16, 3, 40))).toBe('hv'); // a chapter counts on its own, wherever the one before stands
    expect(tierLabel('hv')).toBe('HV (Tier 3)');
    expect(tierLabel(null)).toBe('Not started');
    expect(nextLine(lines(16, 3), 'lv')).toBe('3 of 146 MV quests');
    expect(nextLine({ uhv: { done: 44, total: 44 } }, 'uhv')).toBeNull();
  });

  it('accepts a snapshot and refuses a bad one', () => {
    expect(parseProgressBatch({ server: 'creative', players: [] })).toBeNull();
    expect(parseProgressBatch({ server: 'gtnh', players: [{ uuid: 'x', name: 'A', lines: {}, quests_done: 0, quests_total: 1 }] })).toBeNull();
    expect(parseProgressBatch({ server: 'gtnh', players: [{ uuid: AINO, name: 'Aino V', lines: {}, quests_done: 0, quests_total: 1 }] })).toBeNull();
    expect(parseProgressBatch({ server: 'gtnh', players: [{ uuid: AINO, name: 'AinoV', lines: { lv: { done: 9, total: 5 } }, quests_done: 0, quests_total: 1 }] })).toBeNull();
    expect(parseProgressBatch({ server: 'gtnh', players: [{ uuid: AINO.toUpperCase(), name: 'AinoV', lines: { lv: { done: 2, total: 5 }, bees: { done: 1, total: 1 } }, quests_done: 3, quests_total: 6 }] })).toEqual({
      server: 'gtnh',
      players: [{ uuid: AINO, name: 'AinoV', lines: { lv: { done: 2, total: 5 } }, quests_done: 3, quests_total: 6 }],
    });
  });

  it('stores the snapshot, says when a tier went up, and sorts the board', async () => {
    const first = await applyProgressBatch(env.DB, { server: 'gtnh', players: [{ uuid: AINO, name: 'AinoV', lines: lines(20), quests_done: 226, quests_total: 3739 }] }, NOW);
    expect(first.tiers[AINO]).toEqual({ tier: 'lv', label: 'LV (Tier 1)', up: false }); // the first sighting is a baseline, not news
    const same = await applyProgressBatch(env.DB, { server: 'gtnh', players: [{ uuid: AINO, name: 'AinoV', lines: lines(30), quests_done: 236, quests_total: 3739 }] }, NOW + 100);
    expect(same.tiers[AINO].up).toBe(false);
    const up = await applyProgressBatch(
      env.DB,
      {
        server: 'gtnh',
        players: [
          { uuid: AINO, name: 'AinoV', lines: lines(60, 20), quests_done: 286, quests_total: 3739 },
          { uuid: PEKKA, name: 'Pekka_K', lines: { stone: { done: 12, total: 92 } }, quests_done: 12, quests_total: 3739 },
        ],
      },
      NOW + 200,
    );
    expect(up.tiers[AINO]).toEqual({ tier: 'mv', label: 'MV (Tier 2)', up: true });
    expect(up.tiers[PEKKA].up).toBe(false);
    const board = await progressBoard(env.DB);
    expect(board.map((r) => [r.name, r.tier, r.tier_since])).toEqual([
      ['AinoV', 'mv', NOW + 200],
      ['Pekka_K', 'stone', NOW + 200],
    ]);
    expect(progressLine(board[0])).toBe('MV (Tier 2) · 286 quests · 0 of 115 HV quests');
    expect(progressBoardLines(board)).toContain('🥇 **AinoV** · MV (Tier 2)');
    expect(progressBoardLines([])).toContain('nobody');
    const mine = await progressByUuid(env.DB, [PEKKA, 'nope']);
    expect(mine.get(PEKKA)?.quests_done).toBe(12);
    expect(mine.size).toBe(1);
    // Going back down (a chapter reset) keeps the date of the tier it lands on fresh.
    const down = await applyProgressBatch(env.DB, { server: 'gtnh', players: [{ uuid: AINO, name: 'AinoV', lines: lines(60), quests_done: 266, quests_total: 3739 }] }, NOW + 300);
    expect(down.tiers[AINO]).toEqual({ tier: 'lv', label: 'LV (Tier 1)', up: false });
  });
});
