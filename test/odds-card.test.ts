import { describe, it, expect } from 'vitest';
import { oddsCardPng, oddsCardHeight, poolLabel } from '../src/lib/odds-card';

// The betting board draws, whatever the pools hold.
describe('the betting board', () => {
  it('draws a board with an open pool, a paid-out match and an empty one', async () => {
    const market = (scope: string, winner: string | null) => ({ event_id: 6, scope, opened_at: 1, closed_at: winner ? 2 : null, settled_at: winner ? 3 : null, winner });
    const pools = [
      { market: market('winner', null), odds: { pool: 250, bets: 1, picks: [{ pick: 't:1', staked: 250, backers: 1, share: 1, multiplier: 1 }] }, label: 'Tournament winner' },
      { market: market('m:2:1:0', 't:2'), odds: { pool: 1000, bets: 2, picks: [{ pick: 't:2', staked: 750, backers: 1, share: 0.75, multiplier: 1.33 }, { pick: 't:1', staked: 250, backers: 1, share: 0.25, multiplier: 4 }] }, label: poolLabel('m:2:1:0', { a: 'ggez', b: 'ygygivers' }) },
      { market: market('m:2:1:1', null), odds: { pool: 0, bets: 0, picks: [] }, label: 'solo vs nobody' },
    ];
    const png = await oddsCardPng({ title: 'Rocket League 2v2 Tournament', pools, nameOf: (k) => ({ 't:1': 'ggez', 't:2': 'ygygivers' })[k] ?? k });
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(oddsCardHeight(pools)).toBeGreaterThan(400);
    expect(Array.from((await oddsCardPng({ title: 'Empty', pools: [], nameOf: (k) => k })).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
