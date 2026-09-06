// The bracket as a picture: a column per round, a box per side, winners
// in yellow with a tick, losers faded, byes marked, connectors between
// rounds, the champion named in the header. Drawn with src/lib/raster.ts
// in the brand's colours; the bot attaches it to its bracket messages and
// /events/<id>/bracket.png serves it.

import type { BracketMatch } from './db';
import { Canvas } from './raster';

const BLUE = 0x4169e1;
const YELLOW = 0xffde59;
const INK = 0x1e1e1e;
const GRAY = 0x868686;
const TINT = 0x9ab4ff;
const PALE = 0xdddddd;
const BG = 0xf5f5f5;
const WHITE = 0xffffff;

const PAD = 10;
const BOX_W = 400; // most team names fit whole; longer ones are cut with '..'
const TEXT_H = Canvas.lineHeight('s');
const BOX_H = TEXT_H + 14;
const NAME_W = BOX_W - PAD * 2 - 24; // room for the tick
const BOX_GAP = 4;
const MATCH_H = BOX_H * 2 + BOX_GAP;
const PITCH = MATCH_H + 24;
const COL_GAP = 56;
const MARGIN = 40;
const HEADER = 214;
const FOOTER = 48;

const TICK = ['......11', '.....11.', '....11..', '11.11...', '.111....', '..1.....'];

export function roundTitle(round: number, total: number): string {
  const fromEnd = total - round;
  if (fromEnd === 0) return 'FINAL';
  if (fromEnd === 1) return 'SEMIFINALS';
  if (fromEnd === 2) return 'QUARTERFINALS';
  return `ROUND ${round}`;
}

function fit(name: string, maxWidth = NAME_W): string {
  return Canvas.fit(name, maxWidth, 's');
}

export interface BracketPictureInput {
  matches: BracketMatch[];
  names: Map<string, string>;
  title: string;
  subtitle: string; // "updated 21:34", say
}

// Width and height the picture will have, for callers that size things.
export function bracketPictureSize(matches: BracketMatch[]): { width: number; height: number; rounds: number } {
  const rounds = matches.reduce((max, m) => Math.max(max, m.round), 0);
  const first = matches.filter((m) => m.round === 1).length;
  return {
    rounds,
    width: MARGIN * 2 + rounds * BOX_W + Math.max(0, rounds - 1) * COL_GAP,
    height: HEADER + Math.max(0, first - 1) * PITCH + MATCH_H + FOOTER,
  };
}

export async function bracketPng(input: BracketPictureInput): Promise<Uint8Array> {
  const { matches, names } = input;
  const { rounds, width, height } = bracketPictureSize(matches);
  const canvas = new Canvas(width, height, BG);
  const nameOf = (key: string | null) => (key === null ? '' : fit(names.get(key) ?? 'Unknown'));

  // Header: title, subtitle, and the champion when the final is decided.
  canvas.rect(0, 0, width, 6, BLUE);
  canvas.text(MARGIN, 22, Canvas.fit(input.title.toUpperCase(), width - MARGIN * 2, 'l'), INK, 'l');
  const final = matches.find((m) => m.round === rounds && m.slot === 0);
  const champion = final?.winner ? `Champion: ${nameOf(final.winner)}` : null;
  const subY = 22 + Canvas.lineHeight('l') + 6;
  canvas.text(MARGIN, subY, champion ?? input.subtitle, champion ? BLUE : GRAY, 's');
  if (champion && Canvas.textWidth(champion) + Canvas.textWidth(input.subtitle) + MARGIN * 3 < width) {
    canvas.text(width - MARGIN - Canvas.textWidth(input.subtitle), subY, input.subtitle, GRAY, 's');
  }

  // Match centres: round one evenly spaced, later rounds between their feeders.
  const centre = new Map<string, number>();
  const firstRound = matches.filter((m) => m.round === 1);
  for (const m of firstRound) centre.set(`1:${m.slot}`, HEADER + m.slot * PITCH + MATCH_H / 2);
  for (let round = 2; round <= rounds; round++) {
    for (const m of matches.filter((x) => x.round === round)) {
      const a = centre.get(`${round - 1}:${m.slot * 2}`) ?? HEADER + MATCH_H / 2;
      const b = centre.get(`${round - 1}:${m.slot * 2 + 1}`) ?? a;
      centre.set(`${round}:${m.slot}`, (a + b) / 2);
    }
  }
  const columnX = (round: number) => MARGIN + (round - 1) * (BOX_W + COL_GAP);

  for (let round = 1; round <= rounds; round++) {
    const x = columnX(round);
    canvas.text(x, HEADER - TEXT_H - 12, roundTitle(round, rounds), GRAY, 's');
    for (const m of matches.filter((x) => x.round === round)) {
      const cy = centre.get(`${round}:${m.slot}`)!;
      const top = Math.round(cy - MATCH_H / 2);
      const sides: [string | null, number][] = [
        [m.side_a, top],
        [m.side_b, top + BOX_H + BOX_GAP],
      ];
      const bye = m.side_a !== null && m.side_b === null && m.winner === m.side_a;
      for (const [key, y] of sides) {
        if (key === null) {
          canvas.rect(x, y, BOX_W, BOX_H, PALE);
          if (bye) canvas.text(x + PAD, y + 7, 'bye', GRAY, 's');
          continue;
        }
        const won = m.winner !== null && m.winner === key;
        const lost = m.winner !== null && m.winner !== key;
        canvas.rect(x, y, BOX_W, BOX_H, won ? YELLOW : lost ? TINT : BLUE);
        canvas.text(x + PAD, y + 7, nameOf(key), won || lost ? INK : WHITE, 's');
        if (won) canvas.glyph(x + BOX_W - PAD - 16, y + Math.floor(BOX_H / 2) - 6, TICK, INK, 2);
      }
      // Connector to the next round: out of this match, over, into the next.
      if (round < rounds) {
        const next = centre.get(`${round + 1}:${Math.floor(m.slot / 2)}`);
        if (next !== undefined) {
          const midX = x + BOX_W + COL_GAP / 2;
          canvas.rect(x + BOX_W, Math.round(cy) - 1, COL_GAP / 2, 2, GRAY);
          const y0 = Math.min(Math.round(cy), Math.round(next));
          const y1 = Math.max(Math.round(cy), Math.round(next));
          canvas.rect(midX - 1, y0 - 1, 2, y1 - y0 + 2, GRAY);
          if (m.slot % 2 === 0) canvas.rect(midX, Math.round(next) - 1, COL_GAP / 2, 2, GRAY);
        }
      }
    }
  }

  canvas.text(width - MARGIN - Canvas.textWidth('lahtiag.fi'), height - FOOTER + 10, 'lahtiag.fi', GRAY, 's');
  return canvas.png();
}
