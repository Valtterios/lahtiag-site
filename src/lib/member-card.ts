// The membership card as a picture, for /profile on Discord. The web card
// (components/MemberCard.astro) is the original; this is the same card
// with everything the register protects taken off it.
//
// /profile is public and works on anybody, so the legal name, the member
// number and the membership class cannot be on it — one member must not be
// able to publish another's register entry into a channel. What is left is
// what Discord already knows or the association says out loud: the display
// name, the avatar, the stock, since when, and the figures.

import type { D1Database, Fetcher } from '@cloudflare/workers-types';
import type { MemberStats } from './db';
import type { Honour } from './register';
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

// The brand files, read through the Worker's own asset binding. Asking
// the public origin for them looked right and worked in dev, where
// wrangler answers the loopback from the asset layer; in production the
// request comes back through the route to the Worker itself, which has no
// /brand/ of its own, so every card fell back to the bitmap word and the
// blue stocks hid it well enough that nobody noticed. Only a hit is
// cached: a file that failed once should be tried again on the next card
// rather than being missing for the life of the isolate.
async function art(source: ArtSource, file: string): Promise<Bitmap | null> {
  const known = brand.get(file);
  if (known !== undefined) return known;
  const url = `${source.origin}/brand/${file}`;
  // The binding first, the open road second: whichever answers, the card
  // gets its artwork, and the card is drawn either way if neither does.
  for (const get of [source.assets ? () => source.assets!.fetch(url) : null, () => fetch(url)]) {
    if (!get) continue;
    try {
      const response = await get();
      if (!response.ok) continue;
      const image = await decodePng(new Uint8Array(await response.arrayBuffer()));
      if (image) {
        brand.set(file, image);
        return image;
      }
    } catch {
      // the next way in, or none
    }
  }
  console.log(`member card: ${file} could not be read`);
  return null;
}

const BLUE = 0x4169e1;
const YELLOW = 0xffde59;
const INK = 0x1e1e1e;
const WHITE = 0xffffff;
const LINE = 0xe0e2e8;
const MUTED = 0x5f5f5f;

// Where the wordmark and the mark come from. The origin is only the URL
// they are named by; the binding is what actually answers.
export interface ArtSource {
  origin: string;
  assets?: Fetcher;
}

export type CardTier = 'member' | 'plain' | 'honorary' | 'ink';

export interface CardFace {
  name: string;
  tier: CardTier;
  // What the card calls itself. Only a current member carries a member
  // card; everybody else in the server gets a guest card, which is what
  // the roster already calls them and says nothing about the register —
  // an application waiting on the board is the board's business, not the
  // channel's.
  kind: 'MEMBER CARD' | 'GUEST CARD';
  active: boolean;
  board: boolean; // sits on the board now
  honour: Honour | null; // founded the association, or sat on a past board
  memberSince: number | null;
  avatar: Uint8Array | null; // the PNG bytes, already fetched
  figures: { label: string; value: string }[];
  record: string[];
}

interface Stock {
  bg: number;
  ink: number;
  rule: number; // hairlines and the frame around the photograph
  label: number; // the small capitals over every figure and field
  ruling: number; // the colour of the guilloche
  rulingAlpha: number;
  well: number; // behind a photograph that has not loaded
  chip: number;
  chipInk: number;
}

// A label is the stock's own ink at seven tenths over its ground, which
// is what the web card's `opacity: .7` comes to. The hairline colour was
// standing in for it, and on white — a hairline you can only just see —
// that left every label at the edge of legibility.
const STOCKS: Record<CardTier, Stock> = {
  member: { bg: BLUE, ink: WHITE, rule: 0x7f95e8, label: 0xc6d2f6, ruling: WHITE, rulingAlpha: 0.09, well: 0x3a5fd0, chip: YELLOW, chipInk: INK },
  plain: { bg: WHITE, ink: INK, rule: LINE, label: 0x626262, ruling: INK, rulingAlpha: 0.05, well: 0xededf0, chip: BLUE, chipInk: WHITE },
  honorary: { bg: YELLOW, ink: INK, rule: 0xc9ab44, label: 0x625830, ruling: INK, rulingAlpha: 0.07, well: 0xf2ce46, chip: BLUE, chipInk: WHITE },
  ink: { bg: INK, ink: WHITE, rule: 0x5c5c5c, label: 0xbbbbbb, ruling: WHITE, rulingAlpha: 0.09, well: 0x2b2b2b, chip: YELLOW, chipInk: INK },
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

// The diagonal ruling a printed card is secured with. Set by measuring:
// counted along a plain band with both cards scaled to the same width, the
// web card rules about 38 lines across itself, and these numbers put the
// drawn one at the same. Reasoning from the stylesheet's own 9px instead
// gave half again as many lines, each too thin to survive the picture
// being shown smaller than it was drawn — which is everywhere.
const RULE_GAP = 21;
const RULE_WIDTH = 2.6;

function guilloche(c: Canvas, rgb: number, alpha: number): void {
  const nx = Math.cos((25 * Math.PI) / 180);
  const ny = Math.sin((25 * Math.PI) / 180);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const across = (x * nx + y * ny) % RULE_GAP;
      if (across < RULE_WIDTH) c.blend(x, y, rgb, alpha * Math.min(1, RULE_WIDTH - across));
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

export async function memberCardPng(face: CardFace, back: boolean, source: string | ArtSource): Promise<Uint8Array> {
  const art_ = typeof source === 'string' ? { origin: source } : source;
  const stock = STOCKS[face.tier];
  const c = new Canvas(W, H, stock.bg);
  guilloche(c, stock.ruling, stock.rulingAlpha);
  const pad = 50;
  // The yellow and the white stocks take the blue wordmark; the blue and
  // the ink are dark enough for the white one.
  const light = face.tier === 'honorary' || face.tier === 'plain';
  const [wordmark, mark] = await Promise.all([
    art(art_, light ? 'wordmark-blue.png' : 'wordmark-white.png'),
    art(art_, 'mark-blue.png'),
  ]);

  if (!back) {
    // The mark watermarked into the far corner and running off both
    // edges, the way the web card's does: whole, it sat square across the
    // bottom row and read as a mistake rather than as paper.
    if (mark) drawArt(c, mark, W - 270, H - 220, 306, light ? 0.1 : 0.14, () => (light ? BLUE : WHITE));

    // The logotype is the loudest thing on a card and was set smaller
    // here than on the web card; both sit on the same centre line as the
    // words opposite, whichever of the two is drawn.
    if (wordmark) drawArt(c, wordmark, pad, 24, 230);
    else c.text(pad, 30, 'LAHTIAG', stock.ink, 'l');
    c.text(W - pad - Canvas.textWidth(face.kind), 44, face.kind, stock.ink, 's');

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
    // A name with chips under it is the top of a block that stands
    // against the photograph; a name on its own is the whole block, and
    // sits on the photograph's own centre line rather than its top edge.
    const chips = face.honour !== null || face.board || face.active;
    c.text(tx, chips ? 124 : 157, Canvas.fit(face.name.toUpperCase(), wide, 'l'), stock.ink, 'l');

    let cx = tx;
    // Founding outranks the office and says the same thing for longer;
    // the office outranks having held it.
    if (face.honour === 'founder') cx += chip(c, cx, 196, 'FOUNDER', stock, 'gold') + 14;
    else if (face.board) cx += chip(c, cx, 196, 'BOARD', stock, null) + 14;
    else if (face.honour === 'past_board') cx += chip(c, cx, 196, 'PAST BOARD', stock, null) + 14;
    if (face.active) chip(c, cx, 196, 'ACTIVE', stock, 'silver');

    c.rect(pad, 300, W - pad * 2, 2, stock.rule);
    if (face.figures.length > 0) {
      c.text(pad, 312, 'ALL TIME', stock.label, 's');
      const cell = (W - pad * 2) / face.figures.length;
      face.figures.forEach((f, i) => {
        const x = pad + i * cell;
        const big = Canvas.textWidth(f.value, 'l') <= cell - 20;
        c.text(x, big ? 356 : 368, Canvas.fit(f.value, cell - 20, big ? 'l' : 's'), stock.ink, big ? 'l' : 's');
        c.text(x, 420, Canvas.fit(f.label.toUpperCase(), cell - 20), stock.label, 's');
      });
    } else {
      c.text(pad, 356, 'This member keeps their numbers to themselves.', stock.label, 's');
    }

    // The bottom row the web card has, minus the member number. "Member
    // since — not yet" was a strange thing to tell somebody who never
    // applied, so a player card simply doesn't have the field.
    const dx = face.memberSince === null ? 0 : 320;
    if (face.memberSince !== null) {
      c.text(pad, 470, 'MEMBER SINCE', stock.label, 's');
      c.text(pad, 504, formatHelsinkiDate(face.memberSince), stock.ink, 's');
    }
    c.text(pad + dx, 470, 'DISCORD', stock.label, 's');
    c.text(pad + dx, 504, Canvas.fit(face.name, W - pad * 2 - dx), stock.ink, 's');
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
    c.text(pad, 424, 'Lahti Association of Gaming LAG ry, Lahti.', stock.label, 's');
    c.text(pad, 462, 'Personal and not transferable.', stock.label, 's');
    c.text(pad, 504, 'LAHTIAG.FI/MEMBERSHIP', stock.ink, 's');

    // The mark struck in silver, where a card keeps its hologram.
    if (mark) drawArt(c, mark, W - 178, H - 172, 132, 0.95, (across) => foilAt('silver', across));
  }

  cutShape(c, 22, 34);
  return c.png();
}

// What the card says, built from the same numbers the web card uses.
export function cardFigures(stats: MemberStats, xp: number, messages: number, minecraftMinutes: number): { label: string; value: string }[] {
  return [
    { label: 'Events', value: String(stats.attended) },
    { label: 'Wins', value: String(stats.wins) },
    { label: 'XP', value: String(xp) },
    // Five columns leave 140 px for a label; MESSAGES and MINECRAFT don't fit.
    { label: 'Chat', value: String(messages) },
    { label: 'MC', value: minecraftMinutes > 0 ? voiceLabel(minecraftMinutes) : '-' },
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
    : who.board || entry.honour !== null
      ? 'ink'
      : entry.member_type === 'honorary'
        ? 'honorary'
        : entry.member_type === 'external' || entry.member_type === 'supporting'
          ? 'plain'
          : 'member';
  return {
    name: cleanText(who.name) || 'Member',
    tier,
    kind: member ? 'MEMBER CARD' : 'GUEST CARD',
    active: Boolean(entry?.is_active),
    board: who.board,
    honour: entry?.honour ?? null,
    memberSince: stats.member_since,
    avatar: await fetchAvatar(who.discordId, who.avatarHash),
    figures: lifetime ? cardFigures(stats, lifetime.xp, lifetime.messages, lifetime.minecraft_minutes) : [],
    record: lifetime ? cardRecord(stats, lifetime.voice_minutes) : [],
  };
}

// The avatar. A hash goes stale the moment someone changes their picture,
// and the CDN then answers 404 — so a refused hash falls back to the
// account's default avatar rather than leaving the card with an empty
// well. Nothing at all only if Discord cannot be reached twice, since a
// card without a photograph is still a card and this is not worth failing
// a command over.
async function fetchAvatar(discordId: string, avatarHash: string | null): Promise<Uint8Array | null> {
  const bytes = await tryFetch(avatarUrl(discordId, avatarHash, 256));
  if (bytes || avatarHash === null) return bytes;
  return tryFetch(avatarUrl(discordId, null));
}

async function tryFetch(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length < 4_000_000 ? bytes : null;
  } catch {
    return null;
  }
}
