// The membership card as a picture, for /profile on Discord. The web card
// (components/MemberCard.astro) is the original; this is the same card
// with everything the register protects taken off it.
//
// /profile is public and works on anybody, so the legal name, the member
// number and the membership class cannot be on it — one member must not be
// able to publish another's register entry into a channel. What is left is
// what Discord already knows or the association says out loud: the display
// name, the avatar, the stock, since when, and the figures.

import type { MemberStats } from './db';
import { Canvas, cleanText } from './raster';
import { decodePng } from './png-decode';
import { formatHelsinkiDate } from './time';
import { voiceLabel } from './activity';

const W = 900;
const H = 567; // ID-1, the proportions of a bank card

const BLUE = 0x4169e1;
const YELLOW = 0xffde59;
const INK = 0x1e1e1e;
const WHITE = 0xffffff;
const LINE = 0xe0e2e8;
const MUTED = 0x5f5f5f;

export type CardTier = 'member' | 'plain' | 'honorary' | 'board';

export interface CardFace {
  name: string;
  tier: CardTier;
  active: boolean;
  memberSince: number | null;
  avatar: Uint8Array | null; // the PNG bytes, already fetched
  figures: { label: string; value: string }[];
  record: string[];
}

interface Stock {
  bg: number;
  ink: number;
  rule: number;
  ruling: number;
  chip: number;
  chipInk: number;
}

const STOCKS: Record<CardTier, Stock> = {
  member: { bg: BLUE, ink: WHITE, rule: 0x7f95e8, ruling: 0x4a71e6, chip: YELLOW, chipInk: INK },
  plain: { bg: WHITE, ink: INK, rule: LINE, ruling: 0xf2f2f4, chip: BLUE, chipInk: WHITE },
  honorary: { bg: YELLOW, ink: INK, rule: 0xc9ab44, ruling: 0xf7d654, chip: BLUE, chipInk: WHITE },
  board: { bg: INK, ink: WHITE, rule: 0x5c5c5c, ruling: 0x262626, chip: YELLOW, chipInk: INK },
};

// The bands of a piece of metal, light and dark by turns. The hard turns
// are what make it read as a surface rather than a gradient.
const FOIL = [0x6f7276, 0xdfe3e9, 0x8a9098, 0xffffff, 0x99a0a8, 0xeef1f5, 0x767c84, 0xccd2da, 0x7b8188];

function foilAt(t: number): number {
  const at = Math.min(FOIL.length - 1.001, Math.max(0, t) * (FOIL.length - 1));
  const i = Math.floor(at);
  const f = at - i;
  const mix = (shift: number) =>
    Math.round((((FOIL[i] >> shift) & 0xff) * (1 - f) + ((FOIL[i + 1] >> shift) & 0xff) * f));
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

// Rub out everything outside the card: the three rounded corners and the
// cut one. Worked per pixel with a half-pixel test so the edges are smooth.
function cutShape(c: Canvas, radius: number, notch: number): void {
  const corners: [number, number, number, number][] = [
    [radius, radius, -1, -1],
    [W - radius, radius, 1, -1],
    [radius, H - radius, -1, 1],
    [W - radius, H - radius, 1, 1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    for (let y = 0; y <= radius; y++) {
      for (let x = 0; x <= radius; x++) {
        const px = cx + sx * x;
        const py = cy + sy * y;
        const d = Math.hypot(x, y);
        if (d <= radius - 0.5) continue;
        c.clear(px, py, Math.min(1, d - (radius - 0.5)));
      }
    }
  }
  // The brand's notch, cut off the top-right corner over the rounding.
  for (let y = 0; y < notch; y++) {
    for (let x = W - notch + y; x < W; x++) c.clear(x, y);
    const edge = W - notch + y;
    if (edge - 1 >= 0) c.clear(edge - 1, y, 0.5);
  }
}

// The fine diagonal ruling a printed card is secured with.
function guilloche(c: Canvas, rgb: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = (y * 2) % 9; x < W; x += 9) c.blend(x, y, rgb, 0.55);
  }
}

// A photograph, scaled to a square by nearest neighbour and drawn over
// whatever is there, alpha and all.
function drawAvatar(c: Canvas, image: { width: number; height: number; rgba: Uint8Array }, x: number, y: number, size: number): void {
  const side = Math.min(image.width, image.height);
  const ox = (image.width - side) / 2;
  const oy = (image.height - side) / 2;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const sx = Math.min(image.width - 1, Math.floor(ox + (dx / size) * side));
      const sy = Math.min(image.height - 1, Math.floor(oy + (dy / size) * side));
      const at = (sy * image.width + sx) * 4;
      const rgb = (image.rgba[at] << 16) | (image.rgba[at + 1] << 8) | image.rgba[at + 2];
      c.blend(x + dx, y + dy, rgb, image.rgba[at + 3] / 255);
    }
  }
}

// A chip: the role marker. Foil for an active, flat for the board, cut at
// the top-right corner like everything else the brand draws.
function chip(c: Canvas, x: number, y: number, label: string, stock: Stock, foil: boolean): number {
  const padX = 16;
  const w = Canvas.textWidth(label) + padX * 2;
  const h = 46;
  const notch = 10;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (dx >= w - notch + dy && dy < notch) continue;
      c.blend(x + dx, y + dy, foil ? foilAt(dx / w) : stock.chip);
    }
  }
  c.text(x + padX, y + 6, label, foil ? INK : stock.chipInk, 's');
  return w;
}

export async function memberCardPng(face: CardFace, back: boolean): Promise<Uint8Array> {
  const stock = STOCKS[face.tier];
  const c = new Canvas(W, H, stock.bg);
  guilloche(c, stock.ruling);
  const pad = 50;

  c.text(pad, 34, 'LahtiAG', stock.ink, 'l');
  const kind = back ? 'MEMBER CARD' : 'MEMBER CARD';
  c.text(W - pad - Canvas.textWidth(kind), 48, kind, stock.ink, 's');

  if (!back) {
    // The photograph, in a border, with the same cut corner.
    const size = 150;
    const px = pad;
    const py = 130;
    c.rect(px - 5, py - 5, size + 10, size + 10, stock.rule);
    c.rect(px, py, size, size, stock.ruling);
    if (face.avatar) {
      const image = await decodePng(face.avatar);
      if (image) drawAvatar(c, image, px, py, size);
    }

    const tx = px + size + 40;
    const wide = W - pad - tx;
    const big = Canvas.textWidth(face.name, 'xl') <= wide;
    c.text(tx, big ? 150 : 168, Canvas.fit(face.name, wide, big ? 'xl' : 'l'), stock.ink, big ? 'xl' : 'l');

    let cx = tx;
    if (face.tier === 'board') cx += chip(c, cx, 258, 'BOARD', stock, false) + 14;
    if (face.active) chip(c, cx, 258, 'ACTIVE', stock, true);

    // The figures, under a rule, said to be the whole record.
    const ry = 344;
    c.rect(pad, ry, W - pad * 2, 2, stock.rule);
    if (face.figures.length > 0) {
      c.text(pad, ry + 18, 'ALL TIME', stock.rule, 's');
      const cell = (W - pad * 2) / face.figures.length;
      face.figures.forEach((f, i) => {
        const x = pad + i * cell;
        const size = Canvas.textWidth(f.value, 'l') <= cell - 20 ? 'l' : 's';
        c.text(x, size === 'l' ? 62 + ry : 74 + ry, f.value, stock.ink, size);
        c.text(x, ry + 126, f.label.toUpperCase(), stock.rule, 's');
      });
    } else {
      c.text(pad, ry + 60, 'This member keeps their numbers to themselves.', stock.rule, 's');
    }

    const since = face.memberSince !== null ? `MEMBER SINCE ${formatHelsinkiDate(face.memberSince).toUpperCase()}` : 'NOT A MEMBER';
    c.text(pad, H - pad - 34, since, stock.ink, 's');
  } else {
    // The back: the stripe, the name on its panel, and the rest of the record.
    c.rect(0, 118, W, 76, face.tier === 'board' ? 0x000000 : INK);
    c.rect(pad, 232, W - pad * 2, 62, face.tier === 'plain' ? 0xf5f5f5 : WHITE);
    c.text(pad + 20, 240, Canvas.fit(face.name, W - pad * 2 - 40, 'l'), INK, 'l');

    let y = 326;
    for (const line of face.record) {
      c.text(pad, y, Canvas.fit(line, W - pad * 2), stock.ink, 's');
      y += 40;
    }
    c.text(pad, H - pad - 78, 'Lahti Association of Gaming LAG ry, Lahti.', stock.rule, 's');
    c.text(pad, H - pad - 34, 'LAHTIAG.FI/MEMBERSHIP', stock.ink, 's');
  }

  cutShape(c, 22, 34);
  return c.png();
}

// What the card says, built from the same numbers the web card uses.
export function cardFigures(stats: MemberStats, messages: number, minecraftMinutes: number): { label: string; value: string }[] {
  return [
    { label: 'Events', value: String(stats.attended) },
    { label: 'Wins', value: String(stats.wins) },
    { label: 'Messages', value: String(messages) },
    { label: 'Minecraft', value: minecraftMinutes > 0 ? voiceLabel(minecraftMinutes) : '-' },
  ];
}

export function cardRecord(stats: MemberStats, voiceMinutes: number): string[] {
  const lines = [
    `Tournaments ${stats.tournaments}`,
    `In voice ${voiceMinutes > 0 ? voiceLabel(voiceMinutes) : 'none yet'}`,
  ];
  if (stats.first_event_at !== null) lines.push(`First event ${formatHelsinkiDate(stats.first_event_at)}`);
  if (stats.last_win) lines.push(`Last win ${cleanText(stats.last_win.title)}`);
  return lines;
}
