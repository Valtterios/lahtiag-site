import { describe, it, expect } from 'vitest';
import { Canvas } from '../src/lib/raster';
import { decodePng } from '../src/lib/png-decode';

// The decoder has to read what the encoder writes, and what Discord serves
// for an avatar. Anything it cannot read must come back null so the card is
// drawn without a photograph rather than not at all.

function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function chunk(name: string, body: Uint8Array): Promise<Uint8Array> {
  const out = new Uint8Array(12 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  new DataView(out.buffer).setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A 2x2 palette PNG, filter 0, with one transparent slot.
async function palettePng(): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 2);
  ihdr[8] = 8;
  ihdr[9] = 3; // palette
  const plte = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  const trns = new Uint8Array([0xff, 0x40]);
  const raw = new Uint8Array([0, 0, 1, 0, 1, 0]); // filter byte then two pixels a row
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    await chunk('IHDR', ihdr),
    await chunk('PLTE', plte),
    await chunk('tRNS', trns),
    await chunk('IDAT', await deflate(raw)),
    await chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('decodePng', () => {
  it('reads back what the Canvas wrote, filters and all', async () => {
    const c = new Canvas(9, 7, 0xf5f5f5);
    c.rect(1, 1, 4, 3, 0x4169e1);
    c.rect(5, 4, 3, 2, 0xffde59);
    c.blend(0, 6, 0x000000, 0.5);
    const decoded = await decodePng(await c.png());
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(9);
    expect(decoded!.height).toBe(7);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 9; x++) {
        const at = (y * 9 + x) * 4;
        const got = (decoded!.rgba[at] << 16) | (decoded!.rgba[at + 1] << 8) | decoded!.rgba[at + 2];
        expect(got).toBe(c.colorAt(x, y));
        expect(decoded!.rgba[at + 3]).toBe(255);
      }
    }
  });

  it('reads a palette image, transparency included', async () => {
    const decoded = await decodePng(await palettePng());
    expect(decoded).not.toBeNull();
    expect([...decoded!.rgba.subarray(0, 4)]).toEqual([0xff, 0x00, 0x00, 0xff]);
    expect([...decoded!.rgba.subarray(4, 8)]).toEqual([0x00, 0xff, 0x00, 0x40]);
  });

  it('returns null rather than throwing on anything it cannot read', async () => {
    expect(await decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(await decodePng(new Uint8Array(0))).toBeNull();
    const good = await new Canvas(4, 4, 0x000000).png();
    // A truncated file: the signature is right, the data is not.
    expect(await decodePng(good.subarray(0, 30))).toBeNull();
  });
});
