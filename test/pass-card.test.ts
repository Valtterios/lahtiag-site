import { describe, it, expect } from 'vitest';
import { passCardPng, pageCount, homePage, clampPage, pageLevels, cardHeight, PAGE_SIZE } from '../src/lib/pass-card';
import { passProgress, type PassLevel } from '../src/lib/pass';

// The pass as a picture: the paging, and that every shape of season draws.

const level = (i: number, over: Partial<PassLevel> = {}): PassLevel => ({ id: i, season_year: 2026, level: i, xp: i * 100, name: `Level ${i} name`, reward: `Reward ${i}`, sponsor: i % 3 === 0 ? 'SteelSeries' : null, role_id: null, reached: 0, ...over });
const many = Array.from({ length: 12 }, (_, i) => level(i + 1));

describe('paging', () => {
  it('splits the rungs and opens on the next one to reach', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    expect(pageCount(12)).toBe(3);
    expect(homePage(passProgress(0, many))).toBe(1);
    expect(homePage(passProgress(550, many))).toBe(2); // next is level 6
    expect(homePage(passProgress(5000, many))).toBe(3); // all reached: the last page
    expect(homePage(passProgress(50, []))).toBe(1);
    expect(clampPage(0, 12)).toBe(1);
    expect(clampPage(9, 12)).toBe(3);
    expect(clampPage(Number.NaN, 12)).toBe(1);
    expect(pageLevels(many, 3).map((l) => l.level)).toEqual([11, 12]);
    expect(cardHeight(2)).toBeLessThan(cardHeight(5));
  });
});

describe('the picture', () => {
  const input = (levels: PassLevel[], xp: number, held: number[] = []) => ({ name: 'Aino Virtanen', season: '2026–27', progress: passProgress(xp, levels), held });

  it('draws a page for every shape of season', async () => {
    for (const png of await Promise.all([
      passCardPng(input([], 40)),
      passCardPng(input(many.slice(0, 3), 0)),
      passCardPng(input(many, 550)),
      passCardPng(input(many, 550), 3),
      passCardPng(input(many, 99999)),
      passCardPng(input(many, 50, [2]), 1), // a held level under the XP line
    ])) {
      expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
      expect(png.length).toBeGreaterThan(1000);
    }
  });

  it('draws different pages differently, and a page out of range as the last', async () => {
    const one = await passCardPng(input(many, 550), 1);
    const two = await passCardPng(input(many, 550), 2);
    const beyond = await passCardPng(input(many, 550), 9);
    const last = await passCardPng(input(many, 550), 3);
    expect(one).not.toEqual(two);
    expect(beyond).toEqual(last);
  });
});
