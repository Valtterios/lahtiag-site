import { describe, it, expect } from 'vitest';
import { helsinkiToUnix, formatHelsinki } from '../src/lib/time';

// Helsinki is UTC+2 (EET) in winter and UTC+3 (EEST) in summer. The 2026
// transitions: forward on Sunday 29 March (03:00 -> 04:00 local, 01:00 UTC),
// back on Sunday 25 October (04:00 -> 03:00 local, 01:00 UTC).

const utc = (y: number, mo: number, d: number, h: number, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) / 1000;

describe('helsinkiToUnix', () => {
  it('applies EET (+2) in winter', () => {
    expect(helsinkiToUnix('2026-01-15', '12:00')).toBe(utc(2026, 1, 15, 10));
  });

  it('applies EEST (+3) in summer', () => {
    expect(helsinkiToUnix('2026-07-15', '12:00')).toBe(utc(2026, 7, 15, 9));
  });

  it('is +2 just before the spring transition and +3 just after', () => {
    expect(helsinkiToUnix('2026-03-29', '02:30')).toBe(utc(2026, 3, 29, 0, 30));
    expect(helsinkiToUnix('2026-03-29', '12:00')).toBe(utc(2026, 3, 29, 9));
  });

  it('is +3 just before the autumn transition and +2 just after', () => {
    expect(helsinkiToUnix('2026-10-24', '12:00')).toBe(utc(2026, 10, 24, 9));
    expect(helsinkiToUnix('2026-10-26', '12:00')).toBe(utc(2026, 10, 26, 10));
  });

  it('accepts a dot as the time separator', () => {
    expect(helsinkiToUnix('2026-01-15', '18.30')).toBe(utc(2026, 1, 15, 16, 30));
  });

  it.each([
    ['2026-13-01', '12:00'],
    ['2026-01-32', '12:00'],
    ['2026-1-05', '12:00'],
    ['2026-01-05', '25:00'],
    ['2026-01-05', '12:60'],
    ['soon', '12:00'],
    ['2026-01-05', 'noon'],
  ])('rejects %s %s', (date, time) => {
    expect(helsinkiToUnix(date, time)).toBeNull();
  });
});

describe('formatHelsinki', () => {
  it('renders winter times at +2', () => {
    expect(formatHelsinki(utc(2026, 1, 15, 10))).toContain('12:00');
    expect(formatHelsinki(utc(2026, 1, 15, 10))).toContain('15 Jan 2026');
  });

  it('renders summer times at +3', () => {
    expect(formatHelsinki(utc(2026, 7, 15, 9))).toContain('12:00');
  });

  it('round-trips across both DST transitions', () => {
    for (const [date, time] of [
      ['2026-03-28', '18:00'],
      ['2026-03-29', '18:00'],
      ['2026-10-24', '18:00'],
      ['2026-10-25', '18:00'],
    ] as const) {
      const ts = helsinkiToUnix(date, time)!;
      expect(formatHelsinki(ts)).toContain('18:00');
    }
  });
});
