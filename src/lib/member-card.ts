// The membership card as a picture, for /profile on Discord. The web card
// (components/MemberCard.astro) is the original; this is the same card
// with everything the register protects taken off it.
//
// /profile is public and works on anybody, so the legal name, the member
// number and the membership class cannot be on it — one member must not be
// able to publish another's register entry into a channel. What is left is
// what Discord already knows or the association says out loud: the display
// name, the avatar, the stock, since when, and the figures.

import type { D1Database } from '@cloudflare/workers-types';
import type { MemberStats } from './db';
import { getRegisterByDiscord, isLeaderboardOptIn, memberStats } from './db';
import { avatarUrl } from './discord';
import { lifetimeTotals } from './season';
import { Canvas, cleanText } from './raster';
import { decodePng, type Bitmap } from './png-decode';
import { formatHelsinkiDate } from './time';
import { voiceLabel } from './activity';

const W = 900;
const H = 567; // ID-1, the proportions of a bank card

// The wordmark and the mark are files the site already serves, so the
// Worker fetches them from its own origin and decodes them rather than
// setting the name as text. Kept per isolate: a card is drawn far more
// often than a deploy changes them.
const brand = new Map<string, Bitmap | null>();

async function art(origin: string, file: string): Promise<Bitmap | null> {
  const known = brand.get(file);
  if (known !== undefined) return known;
  let image: Bitmap | null = null;
  try {
    const response = await fetch(`${origin}/brand/${file}`);
    if (response.ok) image = await decodePng(new Uint8Array(await response.arrayBuffer()));
  } catch {
    image = null;
  }
  brand.set(file, image);
  return image;
}

const BLUE = 0x4169e1;
const YELLOW = 0xffde59;
const INK = 0x1e1e1e;
const WHITE = 0xffffff;
const LINE = 0xe0e2e8;
const MUTED = 0x5f5f5f;

export type CardTier = 'member' | 'plain' | 'honorary' | 'ink';

export interface CardFace {
  name: string;
  tier: CardTier;
  active: boolean;
  founder: boolean;
  memberSince: number | null;
  avatar: Uint8Array | null; // the PNG bytes, already fetched
  figures: { label: string; value: string }[];
  record: string[];
}

interface Stock {
  bg: number;
  ink: number;
  rule: number;
  ruling: number; // the colour of the guilloche
  rulingAlpha: number;
  well: number; // behind a photograph that has not loaded
  chip: number;
  chipInk: number;
}

const STOCKS: Record<CardTier, Stock> = {
  member: { bg: BLUE, ink: WHITE, rule: 0x7f95e8, ruling: WHITE, rulingAlpha: 0.09, well: 0x3a5fd0, chip: YELLOW, chipInk: INK },
  plain: { bg: WHITE, ink: INK, rule: LINE, ruling: INK, rulingAlpha: 0.05, well: 0xededf0, chip: BLUE, chipInk: WHITE },
  honorary: { bg: YELLOW, ink: INK, rule: 0xc9ab44, ruling: INK, rulingAlpha: 0.07, well: 0xf2ce46, chip: BLUE, chipInk: WHITE },
  ink: { bg: INK, ink: WHITE, rule: 0x5c5c5c, ruling: WHITE, rulingAlpha: 0.09, well: 0x2b2b2b, chip: YELLOW, chipInk: INK },
};

// The bands of a piece of metal, light and dark by turns. The hard turns
// are what make it read as a surface rather than a gradient. Silver is the
// actives'; gold is the founders', and only theirs.
const FOILS = {
  silver: [0x6f7276, 0xdfe3e9, 0x8a9098, 0xffffff, 0x99a0a8, 0xeef1f5, 0x767c84, 0xccd2da, 0x7b8188],
  gold: [0x8a6a1f, 0xf8e6a8, 0xc9a247, 0xfffbe9, 0xd4af4f, 0xf4e4ab, 0xa67f28, 0xe9d182, 0x8f6d21],
};
type Foil = keyof typeof FOILS;

function foilAt(metal: Foil, t: number): number {
  const bands = FOILS[metal];
  const at = Math.min(bands.length - 1.001, Math.max(0, t) * (bands.length - 1));
  const i = Math.floor(at);
  const f = at - i;
  const mix = (shift: number) =>
    Math.round((((bands[i] >> shift) & 0xff) * (1 - f) + ((bands[i + 1] >> shift) & 0xff) * f));
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

// The fine diagonal ruling a printed card is secured with: unbroken lines
// a pixel wide, nine apart, leaning the way the web card's do. Drawn from
// the distance along the lines' own normal, so they stay continuous
// instead of breaking into dots.
function guilloche(c: Canvas, rgb: number, alpha: number): void {
  const nx = Math.cos((25 * Math.PI) / 180);
  const ny = Math.sin((25 * Math.PI) / 180);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const across = (x * nx + y * ny) % 9;
      if (across < 1) c.blend(x, y, rgb, alpha * (1 - across));
    }
  }
}

// A photograph, cropped square and scaled by nearest neighbour.
function drawAvatar(c: Canvas, image: Bitmap, x: number, y: number, size: number): void {
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

// An image drawn to a width, keeping its proportions. `paint` decides the
// colour: the brand's own where it is undefined, a flat one for a wordmark
// knocked out white, a run of metal for the foil stamp on the back. The
// image's alpha is the shape either way.
function drawArt(
  c: Canvas,
  image: Bitmap,
  x: number,
  y: number,
  width: number,
  opacity = 1,
  paint?: (across: number) => number,
): number {
  const height = Math.round((width / image.width) * image.height);
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const sx = Math.min(image.width - 1, Math.floor((dx / width) * image.width));
      const sy = Math.min(image.height - 1, Math.floor((dy / height) * image.height));
      const at = (sy * image.width + sx) * 4;
      const alpha = (image.rgba[at + 3] / 255) * opacity;
      if (alpha <= 0.004) continue;
      const rgb = paint ? paint(dx / width) : (image.rgba[at] << 16) | (image.rgba[at + 1] << 8) | image.rgba[at + 2];
      c.blend(x + dx, y + dy, rgb, alpha);
    }
  }
  return height;
}

// A chip: the role marker. Struck in metal for an active or a founder,
// flat for the board, cut at the top-right corner like everything else the
// brand draws.
function chip(c: Canvas, x: number, y: number, label: string, stock: Stock, foil: Foil | null): number {
  const padX = 16;
  const w = Canvas.textWidth(label) + padX * 2;
  const h = 46;
  const notch = 10;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (dx >= w - notch + dy && dy < notch) continue;
      c.blend(x + dx, y + dy, foil ? foilAt(foil, dx / w) : stock.chip);
    }
  }
  c.text(x + padX, y + 6, label, foil ? INK : stock.chipInk, 's');
  return w;
}

// Break a line of text to a width, at most so many lines; the last one is
// cut with a mark if the rest will not fit.
function wrap(text: string, width: number, lines: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (Canvas.textWidth(next) <= width || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = word;
    if (out.length === lines - 1) break;
  }
  const rest = words.slice(out.join(' ').split(' ').filter(Boolean).length).join(' ');
  out.push(Canvas.fit(out.length === lines - 1 ? rest : line, width));
  return out.slice(0, lines);
}

export async function memberCardPng(face: CardFace, back: boolean, origin: string): Promise<Uint8Array> {
  const stock = STOCKS[face.tier];
  const c = new Canvas(W, H, stock.bg);
  guilloche(c, stock.ruling, stock.rulingAlpha);
  const pad = 50;
  // The yellow and the white stocks take the blue wordmark; the blue and
  // the ink are dark enough for the white one.
  const light = face.tier === 'honorary' || face.tier === 'plain';
  const [wordmark, mark] = await Promise.all([
    art(origin, light ? 'wordmark-blue.png' : 'wordmark-white.png'),
    art(origin, 'mark-blue.png'),
  ]);

  if (!back) {
    // The mark watermarked into the far corner, as on the web card.
    if (mark) drawArt(c, mark, W - 232, H - 214, 268, light ? 0.1 : 0.07, () => (light ? BLUE : WHITE));

    if (wordmark) drawArt(c, wordmark, pad, 34, 168);
    else c.text(pad, 30, 'LAHTIAG', stock.ink, 'l');
    const kind = 'MEMBER CARD';
    c.text(W - pad - Canvas.textWidth(kind), 42, kind, stock.ink, 's');

    const size = 150;
    const px = pad;
    const py = 108;
    c.rect(px - 5, py - 5, size + 10, size + 10, stock.rule);
    c.rect(px, py, size, size, stock.well);
    if (face.avatar) {
      const image = await decodePng(face.avatar);
      if (image) drawAvatar(c, image, px, py, size);
    }

    // Upper case throughout, as on the web: the large font has ÄÖÅ but not
    // äöå, so a Finnish name only survives in capitals.
    const tx = px + size + 40;
    const wide = W - pad - tx;
    c.text(tx, 124, Canvas.fit(face.name.toUpperCase(), wide, 'l'), stock.ink, 'l');

    let cx = tx;
    if (face.founder) cx += chip(c, cx, 196, 'FOUNDER', stock, 'gold') + 14;
    else if (face.tier === 'ink') cx += chip(c, cx, 196, 'BOARD', stock, null) + 14;
    if (face.active) chip(c, cx, 196, 'ACTIVE', stock, 'silver');

    c.rect(pad, 300, W - pad * 2, 2, stock.rule);
    if (face.figures.length > 0) {
      c.text(pad, 312, 'ALL TIME', stock.rule, 's');
      const cell = (W - pad * 2) / face.figures.length;
      face.figures.forEach((f, i) => {
        const x = pad + i * cell;
        const big = Canvas.textWidth(f.value, 'l') <= cell - 20;
        c.text(x, big ? 356 : 368, Canvas.fit(f.value, cell - 20, big ? 'l' : 's'), stock.ink, big ? 'l' : 's');
        c.text(x, 420, Canvas.fit(f.label.toUpperCase(), cell - 20), stock.rule, 's');
      });
    } else {
      c.text(pad, 356, 'This member keeps their numbers to themselves.', stock.rule, 's');
    }

    // The bottom row the web card has, minus the member number.
    c.text(pad, 470, 'MEMBER SINCE', stock.rule, 's');
    c.text(pad, 504, face.memberSince !== null ? formatHelsinkiDate(face.memberSince) : 'not yet', stock.ink, 's');
    c.text(pad + 320, 470, 'DISCORD', stock.rule, 's');
    c.text(pad + 320, 504, Canvas.fit(face.name, W - pad * 2 - 320), stock.ink, 's');
  } else {
    // The back carries no wordmark, as the web card's does not: the stripe
    // is the first thing, the way it is on a card you turn over.
    c.rect(0, 58, W, 82, face.tier === 'ink' ? 0x000000 : INK);
    const panelY = 184;
    c.rect(pad, panelY, W - pad * 2, 66, face.tier === 'plain' ? 0xf5f5f5 : WHITE);
    c.text(pad + 22, panelY + 6, Canvas.fit(face.name.toUpperCase(), W - pad * 2 - 44, 'l'), INK, 'l');

    let y = 296;
    for (const line of wrap(face.record.join(' · '), W - pad * 2, 2)) {
      c.text(pad, y, line, stock.ink, 's');
      y += 40;
    }
    c.text(pad, 424, 'Lahti Association of Gaming LAG ry, Lahti.', stock.rule, 's');
    c.text(pad, 462, 'Personal and not transferable.', stock.rule, 's');
    c.text(pad, 504, 'LAHTIAG.FI/MEMBERSHIP', stock.ink, 's');

    // The mark struck in silver, where a card keeps its hologram.
    if (mark) drawArt(c, mark, W - 178, H - 172, 132, 0.95, (across) => foilAt('silver', across));
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

// Everything the card needs, gathered in one place so the page and the
// slash command draw exactly the same thing.
//
// Hiding yourself from the leaderboard takes the figures off: the opt-out
// is about numbers, and half of one that still published the whole record
// would not be worth having.
export async function cardFace(
  db: D1Database,
  who: { discordId: string; name: string; avatarHash: string | null; board: boolean },
  now: number,
): Promise<CardFace> {
  const [entry, stats, shown] = await Promise.all([
    getRegisterByDiscord(db, who.discordId),
    memberStats(db, who.discordId, now),
    isLeaderboardOptIn(db, who.discordId),
  ]);
  const lifetime = shown ? await lifetimeTotals(db, who.discordId) : null;
  const member = entry?.status === 'member';
  const tier: CardTier = !member
    ? 'plain'
    : who.board || entry.founder
      ? 'ink'
      : entry.member_type === 'honorary'
        ? 'honorary'
        : entry.member_type === 'external' || entry.member_type === 'supporting'
          ? 'plain'
          : 'member';
  return {
    name: cleanText(who.name) || 'Member',
    tier,
    active: Boolean(entry?.is_active),
    founder: Boolean(entry?.founder),
    memberSince: stats.member_since,
    avatar: await fetchAvatar(who.discordId, who.avatarHash),
    figures: lifetime ? cardFigures(stats, lifetime.messages, lifetime.minecraft_minutes) : [],
    record: lifetime ? cardRecord(stats, lifetime.voice_minutes) : [],
  };
}

// The avatar, or nothing: a card without a photograph is still a card, and
// Discord's CDN is not worth failing a command over.
async function fetchAvatar(discordId: string, avatarHash: string | null): Promise<Uint8Array | null> {
  try {
    const response = await fetch(avatarUrl(discordId, avatarHash, 256));
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length < 4_000_000 ? bytes : null;
  } catch {
    return null;
  }
}
