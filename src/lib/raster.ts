// A tiny raster canvas for pictures the Worker draws itself: the bracket
// picture the bot posts (src/lib/bracket-image.ts). Cloudflare Workers have
// no image library, so this is filled rectangles, a pixel font, and a PNG
// encoder. Indexed colour (one byte per pixel, a palette of at most 256)
// keeps the raw image small, and the runtime's own deflate does the rest.
// Truecolour with alpha rather than a palette: a photograph — a member's
// avatar on their card — has more colours in it than a palette holds, and
// so does a metallic sweep, while the alpha is what lets a card have
// rounded corners and a cut one on whatever Discord puts behind it.

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
// Characters the fonts lack (other scripts, symbols) are skipped, not
// drawn as '?': a name in another script comes out shorter, not wrong.
export function drawable(ch: string): boolean {
  return ch in FONTS.s.glyphs;
}

// NFKC first: fancy Unicode letters (𝙿𝙻𝚇𝚃, ｆｕｌｌｗｉｄｔｈ) fold to plain ones.
export function cleanText(text: string): string {
  return [...text.normalize('NFKC')].filter(drawable).join('').replace(/\s+/g, ' ').trim();
}

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
  readonly pixels: Uint8Array; // four bytes a pixel, R G B A

  constructor(
    readonly width: number,
    readonly height: number,
    background: number,
  ) {
    this.pixels = new Uint8Array(width * height * 4);
    this.rect(0, 0, width, height, background);
  }

  rect(x: number, y: number, w: number, h: number, rgb: number): void {
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = rgb & 0xff;
    const x0 = Math.max(0, x);
    const x1 = Math.min(this.width, x + w);
    if (x1 <= x0) return;
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
      let at = (row * this.width + x0) * 4;
      for (let col = x0; col < x1; col++) {
        this.pixels[at++] = r;
        this.pixels[at++] = g;
        this.pixels[at++] = b;
        this.pixels[at++] = 0xff;
      }
    }
  }

  // One pixel, blended over what is there. Alpha 1 replaces it. Painting
  // onto a cleared pixel takes the colour rather than muddying it with
  // whatever was underneath, which is what a card's cut corner wants.
  blend(x: number, y: number, rgb: number, alpha = 1): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 4;
    const was = this.pixels[at + 3] / 255;
    const now = alpha + was * (1 - alpha);
    for (let c = 0; c < 3; c++) {
      const fg = (rgb >> (16 - 8 * c)) & 0xff;
      this.pixels[at + c] = Math.round((fg * alpha + this.pixels[at + c] * was * (1 - alpha)) / (now || 1));
    }
    this.pixels[at + 3] = Math.round(now * 255);
  }

  // Rub a pixel out, wholly or partly: how the corners are cut.
  clear(x: number, y: number, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 4;
    this.pixels[at + 3] = Math.round(this.pixels[at + 3] * (1 - Math.min(1, Math.max(0, alpha))));
  }

  colorAt(x: number, y: number): number {
    const at = (y * this.width + x) * 4;
    return (this.pixels[at] << 16) | (this.pixels[at + 1] << 8) | this.pixels[at + 2];
  }

  alphaAt(x: number, y: number): number {
    return this.pixels[(y * this.width + x) * 4 + 3];
  }

  // Anti-aliased text: each glyph pixel carries one of four levels, and
  // the level blends the text colour into whatever is already there, so
  // edges look smooth on any background. Unknown characters become '?'.
  text(x: number, y: number, text: string, rgb: number, size: FontSize = 's'): void {
    const font = FONTS[size];
    let cx = x;
    for (const ch of text.normalize('NFKC')) {
      if (!(ch in font.glyphs)) continue;
      const { w, px: glyph } = levels(size, ch);
      let i = 0;
      for (let gy = 0; gy < font.h; gy++) {
        const py = y + gy;
        for (let gx = 0; gx < w; gx++, i++) {
          const level = glyph[i];
          if (level === 0) continue;
          this.blend(cx + gx, py, rgb, level / 3);
        }
      }
      cx += w;
    }
  }

  static textWidth(text: string, size: FontSize = 's'): number {
    const font = FONTS[size];
    let w = 0;
    for (const ch of text.normalize('NFKC')) w += font.glyphs[ch]?.w ?? 0;
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
    const stride = this.width * 4;
    // Filter 2 (up) on every row but the first: a card is bands of flat
    // colour, so most rows subtract to zero and deflate eats them.
    const raw = new Uint8Array((stride + 1) * this.height);
    for (let row = 0; row < this.height; row++) {
      const to = row * (stride + 1);
      const from = row * stride;
      if (row === 0) {
        raw[to] = 0;
        raw.set(this.pixels.subarray(0, stride), to + 1);
        continue;
      }
      raw[to] = 2;
      for (let i = 0; i < stride; i++) {
        raw[to + 1 + i] = (this.pixels[from + i] - this.pixels[from - stride + i]) & 0xff;
      }
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, this.width);
    view.setUint32(4, this.height);
    header[8] = 8; // bit depth
    header[9] = 6; // truecolour with alpha
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
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
