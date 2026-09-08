// Reading a PNG, which the Worker needs for exactly one thing: a member's
// Discord avatar on their card. The encoder in raster.ts writes one flavour;
// this reads the flavours Discord serves — 8-bit truecolour, greyscale,
// palette, with or without alpha. Anything else, and the caller draws the
// card without a photograph rather than failing.
//
// The runtime's own DecompressionStream does the inflating, the same way
// raster.ts leans on CompressionStream to deflate.

export interface Bitmap {
  width: number;
  height: number;
  rgba: Uint8Array; // four bytes a pixel
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Bytes a pixel, by PNG colour type. 1, 5 and 7 do not exist.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The four filters that look backwards, per the PNG spec. `bpp` is the
// distance to the pixel on the left in bytes, which is what "a" means.
function unfilter(rows: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = rows[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    const up = to - stride;
    for (let i = 0; i < stride; i++) {
      const raw = rows[from + i];
      const a = i >= bpp ? out[to + i - bpp] : 0;
      const b = y > 0 ? out[up + i] : 0;
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
      let value: number;
      switch (type) {
        case 0: value = raw; break;
        case 1: value = raw + a; break;
        case 2: value = raw + b; break;
        case 3: value = raw + ((a + b) >> 1); break;
        case 4: {
          // Paeth: whichever of left, above and above-left the gradient is nearest.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`png: filter ${type}`);
      }
      out[to + i] = value & 0xff;
    }
  }
  return out;
}

export async function decodePng(bytes: Uint8Array): Promise<Bitmap | null> {
  try {
    for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let palette: Uint8Array | null = null;
    let alphas: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    while (at + 8 <= bytes.length) {
      const length = view.getUint32(at);
      const name = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
      const body = bytes.subarray(at + 8, at + 8 + length);
      if (name === 'IHDR') {
        width = view.getUint32(at + 8);
        height = view.getUint32(at + 12);
        depth = bytes[at + 16];
        colour = bytes[at + 17];
        // Interlaced (Adam7) is a different unfiltering job; nothing we
        // are given uses it, so it is refused rather than half-read.
        if (bytes[at + 20] !== 0) return null;
      } else if (name === 'PLTE') {
        palette = body.slice();
      } else if (name === 'tRNS') {
        alphas = body.slice();
      } else if (name === 'IDAT') {
        idat.push(body.slice());
      } else if (name === 'IEND' || name === 'fdAT') {
        // fdAT means an animated PNG; the frames past the first are not
        // ours to read, and IDAT already holds a whole still image.
        break;
      }
      at += 12 + length;
    }
    const channels = CHANNELS[colour];
    if (depth !== 8 || !channels || width <= 0 || height <= 0 || idat.length === 0) return null;
    if (width * height > 4_000_000) return null; // a card photo, not a poster

    const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of idat) {
      joined.set(part, offset);
      offset += part.length;
    }
    const rows = await inflate(joined);
    if (rows.length < (width * channels + 1) * height) return null;
    const flat = unfilter(rows, width, height, channels);

    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0, px = 0; px < width * height; px++) {
      const from = px * channels;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colour === 3) {
        const slot = flat[from];
        if (!palette || slot * 3 + 2 >= palette.length) return null;
        r = palette[slot * 3];
        g = palette[slot * 3 + 1];
        b = palette[slot * 3 + 2];
        if (alphas && slot < alphas.length) a = alphas[slot];
      } else if (colour === 0 || colour === 4) {
        r = g = b = flat[from];
        if (colour === 4) a = flat[from + 1];
      } else {
        r = flat[from];
        g = flat[from + 1];
        b = flat[from + 2];
        if (colour === 6) a = flat[from + 3];
      }
      rgba[i++] = r;
      rgba[i++] = g;
      rgba[i++] = b;
      rgba[i++] = a;
    }
    return { width, height, rgba };
  } catch {
    return null;
  }
}
