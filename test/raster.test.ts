import { describe, it, expect } from 'vitest';
import { Canvas, cleanText, drawable } from '../src/lib/raster';
import { bracketPng, bracketPictureSize, roundTitle } from '../src/lib/bracket-image';
import type { BracketMatch } from '../src/lib/db';

// The Worker's own picture drawing: a valid truecolour PNG comes out,
// sized by the bracket.

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

describe('Canvas', () => {
  it('encodes a truecolour PNG with the right header and dimensions', async () => {
    const c = new Canvas(30, 20, 0xf5f5f5);
    c.rect(2, 2, 10, 5, 0x4169e1);
    c.text(1, 8, 'Hi ✓', 0x1e1e1e, 's');
    const png = await c.png();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    expect(u32(png, 16)).toBe(30);
    expect(u32(png, 20)).toBe(20);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // truecolour with alpha
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
    expect(Canvas.textWidth('abc')).toBeGreaterThan(20);
    expect(Canvas.textWidth('abc', 'l')).toBeGreaterThan(Canvas.textWidth('abc'));
    expect(Canvas.fit('a very long name indeed', 60)).toMatch(/\.\.$/);
    expect(drawable('ä')).toBe(true);
    expect(drawable('吴')).toBe(false);
    expect(cleanText('r-yaaa 吴海湛 ：）')).toBe('r-yaaa :)');
    expect(cleanText('! 𝙿𝙻𝚇𝚃 i')).toBe('! PLXT i');
    expect(Canvas.textWidth('吴海湛')).toBe(0);
  });

  it('clips drawing to the canvas', () => {
    const c = new Canvas(4, 4, 0x000000);
    c.rect(-5, -5, 100, 100, 0xffffff);
    expect([...new Set(c.pixels)]).toEqual([255]);
    c.rect(10, 10, 5, 5, 0x123456);
    expect(c.pixels.every((p) => p === 255)).toBe(true);
    expect(c.colorAt(0, 0)).toBe(0xffffff);
    expect(c.alphaAt(0, 0)).toBe(255);
  });

  it('blends a colour over what is already there', () => {
    const c = new Canvas(2, 1, 0x000000);
    c.blend(0, 0, 0xffffff, 0.5);
    expect(c.colorAt(0, 0)).toBe(0x808080);
    c.blend(1, 0, 0xff0000);
    expect(c.colorAt(1, 0)).toBe(0xff0000);
    c.blend(5, 0, 0xff0000); // off the canvas, ignored
    c.clear(0, 0);
    expect(c.alphaAt(0, 0)).toBe(0);
  });
});

describe('bracket picture', () => {
  const m = (round: number, slot: number, a: string | null, b: string | null, winner: string | null = null): BracketMatch => ({ event_id: 1, round, slot, side_a: a, side_b: b, winner });
  const names = new Map([['t:1', 'Alpha'], ['t:2', 'Bravo'], ['t:3', 'Charlie'], ['t:4', 'Delta'], ['t:5', 'A very long team name indeed']]);

  it('sizes by rounds and first-round matches, and labels rounds', () => {
    const matches = [m(1, 0, 't:1', 't:2'), m(1, 1, 't:3', 't:4'), m(2, 0, null, null)];
    const size = bracketPictureSize(matches);
    expect(size.rounds).toBe(2);
    expect(size.width).toBeGreaterThan(size.rounds * 300);
    expect(size.height).toBeGreaterThan(200);
    expect(roundTitle(1, 3)).toBe('QUARTERFINALS');
    expect(roundTitle(3, 3)).toBe('FINAL');
    expect(roundTitle(1, 5)).toBe('ROUND 1');
  });

  it('draws a decided bracket with byes into a PNG of the announced size', async () => {
    const matches = [m(1, 0, 't:1', 't:2', 't:1'), m(1, 1, 't:5', null, 't:5'), m(2, 0, 't:1', 't:5', 't:5')];
    const png = await bracketPng({ matches, names, title: 'Cup', subtitle: 'updated now' });
    const size = bracketPictureSize(matches);
    expect(u32(png, 16)).toBe(size.width);
    expect(u32(png, 20)).toBe(size.height);
    expect(png.length).toBeLessThan(200_000);
  });
});
