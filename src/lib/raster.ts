// A tiny raster canvas for pictures the Worker draws itself: the bracket
// picture the bot posts (src/lib/bracket-image.ts). Cloudflare Workers have
// no image library, so this is filled rectangles, a pixel font, and a PNG
// encoder. Indexed colour (one byte per pixel, a palette of at most 256)
// keeps the raw image small, and the runtime's own deflate does the rest.

import { FONTS, type FontSize } from './font';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Glyphs decoded once per size and character: one byte per pixel with
// the level 0-3. Decoding the hex on every draw was the slow part.
const decoded = new Map<string, Uint8Array>();
function levels(size: FontSize, ch: string): { w: number; px: Uint8Array } {
  const font = FONTS[size];
  const glyph = font.glyphs[ch] ?? font.glyphs['?'];
  const key = `${size}:${ch in font.glyphs ? ch : '?'}`;
  let px = decoded.get(key);
  if (!px) {
    px = new Uint8Array(glyph.w * font.h);
    for (let i = 0; i < px.length; i++) {
      const byte = parseInt(glyph.d.slice((i >> 2) * 2, (i >> 2) * 2 + 2), 16);
      px[i] = (byte >> (6 - 2 * (i & 3))) & 3;
    }
    decoded.set(key, px);
  }
  return { w: glyph.w, px };
}

export class Canvas {
  readonly pixels: Uint8Array;
  private readonly palette: number[] = [];
  private readonly slots = new Map<number, number>(); // colour -> palette index

  constructor(
    readonly width: number,
    readonly height: number,
    background: number,
  ) {
    this.pixels = new Uint8Array(width * height);
    this.pixels.fill(this.index(background));
  }

  // Colours are 0xRRGGBB; each new one takes a palette slot.
  index(rgb: number): number {
    const known = this.slots.get(rgb);
    if (known !== undefined) return known;
    if (this.palette.length >= 256) throw new Error('palette full');
    this.palette.push(rgb);
    this.slots.set(rgb, this.palette.length - 1);
    return this.palette.length - 1;
  }

  rect(x: number, y: number, w: number, h: number, rgb: number): void {
    const color = this.index(rgb);
    const x0 = Math.max(0, x);
    const x1 = Math.min(this.width, x + w);
    if (x1 <= x0) return;
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
      this.pixels.fill(color, row * this.width + x0, row * this.width + x1);
    }
  }

  // Anti-aliased text: each glyph pixel carries one of four levels, and
  // the level blends the text colour into whatever is already there, so
  // edges look smooth on any background. Unknown characters become '?'.
  text(x: number, y: number, text: string, rgb: number, size: FontSize = 's'): void {
    const font = FONTS[size];
    const solid = this.index(rgb);
    let cx = x;
    for (const ch of text) {
      const { w, px: glyph } = levels(size, ch);
      let i = 0;
      for (let gy = 0; gy < font.h; gy++) {
        const py = y + gy;
        for (let gx = 0; gx < w; gx++, i++) {
          const level = glyph[i];
          if (level === 0) continue;
          const px = cx + gx;
          if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
          const at = py * this.width + px;
          this.pixels[at] = level === 3 ? solid : this.blended(rgb, this.palette[this.pixels[at]], level / 3);
        }
      }
      cx += w;
    }
  }

  static textWidth(text: string, size: FontSize = 's'): number {
    const font = FONTS[size];
    let w = 0;
    for (const ch of text) w += (font.glyphs[ch] ?? font.glyphs['?']).w;
    return w;
  }

  static lineHeight(size: FontSize = 's'): number {
    return FONTS[size].h;
  }

  // Cut a string so it fits a width, with a trailing mark.
  static fit(text: string, maxWidth: number, size: FontSize = 's'): string {
    if (Canvas.textWidth(text, size) <= maxWidth) return text;
    const chars = [...text];
    while (chars.length > 0 && Canvas.textWidth(`${chars.join('')}..`, size) > maxWidth) chars.pop();
    return `${chars.join('')}..`;
  }

  // The colour between two, by alpha; a full palette falls back to the text colour.
  private blended(fg: number, bg: number, alpha: number): number {
    const mix = (shift: number) => Math.round(((bg >> shift) & 0xff) * (1 - alpha) + ((fg >> shift) & 0xff) * alpha);
    const rgb = (mix(16) << 16) | (mix(8) << 8) | mix(0);
    try {
      return this.index(rgb);
    } catch {
      return this.index(fg);
    }
  }

  // A small bitmap (rows of '1'/'.') drawn at a scale, for marks the font
  // lacks, like the winner's tick.
  glyph(x: number, y: number, rows: string[], rgb: number, scale = 2): void {
    rows.forEach((row, gy) => {
      [...row].forEach((cell, gx) => {
        if (cell === '1') this.rect(x + gx * scale, y + gy * scale, scale, scale, rgb);
      });
    });
  }

  async png(): Promise<Uint8Array> {
    const raw = new Uint8Array((this.width + 1) * this.height);
    for (let row = 0; row < this.height; row++) {
      raw[row * (this.width + 1)] = 0; // filter: none
      raw.set(this.pixels.subarray(row * this.width, (row + 1) * this.width), row * (this.width + 1) + 1);
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, this.width);
    view.setUint32(4, this.height);
    header[8] = 8; // bit depth
    header[9] = 3; // indexed colour
    const plte = new Uint8Array(this.palette.length * 3);
    this.palette.forEach((rgb, i) => {
      plte[i * 3] = (rgb >> 16) & 0xff;
      plte[i * 3 + 1] = (rgb >> 8) & 0xff;
      plte[i * 3 + 2] = rgb & 0xff;
    });
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('PLTE', plte),
      chunk('IDAT', await deflate(raw)),
      chunk('IEND', new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}
