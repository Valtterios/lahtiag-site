// The season pass as a picture: the member's XP, the bar to the next
// level, and the season's levels as a list of rungs with their rewards,
// the reached ones ticked. Drawn like the profile card (src/lib/raster.ts:
// flat rectangles and the pixel font), for the membership page and for
// /pass on Discord. A season with many levels is paged, PAGE_SIZE rungs
// to a picture, and the first page opens on the one to reach next.

import { Canvas, cleanText } from './raster';
import { levelTitle, type PassLevel, type PassProgress } from './pass';

const BLUE = 0x4169e1;
const YELLOW = 0xffde59;
const INK = 0x1e1e1e;
const GRAY = 0x868686;
const LIGHT = 0xdcdcdc;
const BG = 0xf5f5f5;
const WHITE = 0xffffff;
const PALE = 0xe9eeff; // the next rung's tile

export const PAGE_SIZE = 5;
const W = 900;
const HEAD = 150; // the blue band
const BAR_TOP = 190; // the progress bar
const ROWS_TOP = 250;
const ROW_H = 78; // name and reward
const ROW_SPONSORED = 106; // and a line for whose name is on the level
const ROW_GAP = 12;
const FOOT = 60;
const X0 = 40;

const TICK = ['......11', '.....11.', '....11..', '11.11...', '.111....', '..1.....'];

export interface PassCardInput {
  name: string; // the member's Discord name, already what the font can draw
  season: string; // '2026–27'
  progress: PassProgress;
  held: number[]; // level ids from the ledger: reached and kept, whatever the XP now
}

export function pageCount(levels: number): number {
  return Math.max(1, Math.ceil(levels / PAGE_SIZE));
}

// The page a member opens on: the one with the next rung to reach, or
// the last when every level is theirs. Pages are 1-based.
export function homePage(progress: PassProgress): number {
  const at = progress.next ? progress.levels.findIndex((l) => l.id === progress.next!.id) : progress.levels.length - 1;
  return Math.floor(Math.max(0, at) / PAGE_SIZE) + 1;
}

export function clampPage(page: number, levels: number): number {
  return Math.min(pageCount(levels), Math.max(1, Math.floor(page) || 1));
}

export function pageLevels(levels: PassLevel[], page: number): PassLevel[] {
  const p = clampPage(page, levels.length);
  return levels.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
}

// A sponsored level has a line more: the sponsor's name is what the
// sponsor gets for the prize, so it is never squeezed or cut.
export function rowHeight(level: Pick<PassLevel, 'sponsor'>): number {
  return level.sponsor ? ROW_SPONSORED : ROW_H;
}

// The picture's height follows the rungs on the page, so a short season
// gets a short card rather than empty rows.
export function cardHeight(rows: Pick<PassLevel, 'sponsor'>[]): number {
  const body = rows.length === 0 ? ROW_H : rows.reduce((h, l) => h + rowHeight(l) + ROW_GAP, 0) - ROW_GAP;
  return ROWS_TOP + body + FOOT;
}

// The XP figure, digits in the biggest size when they fit, with the
// unit beside them on the same baseline; right-aligned to x.
function xpFigure(c: Canvas, x: number, y: number, xp: number): void {
  const text = String(xp);
  const unitW = Canvas.textWidth('XP', 'l');
  const big = Canvas.textWidth(text, 'xl') + 14 + unitW <= 330;
  const size = big ? 'xl' : 'l';
  const digitsW = Canvas.textWidth(text, size);
  // Each face's bitmap has its baseline a fixed way down; these offsets
  // put the unit's baseline on the digits'.
  const unitY = big ? y + 38 : y;
  c.text(x - unitW, unitY, 'XP', 0xffeba4, 'l');
  c.text(x - unitW - 14 - digitsW, big ? y : unitY, text, WHITE, size);
}

export async function passCardPng(input: PassCardInput, page = homePage(input.progress)): Promise<Uint8Array> {
  const { progress } = input;
  const levels = progress.levels;
  const pages = pageCount(levels.length);
  const p = clampPage(page, levels.length);
  const rows = pageLevels(levels, p);
  const H = cardHeight(rows);
  const c = new Canvas(W, H, BG);

  // Header band: the season, the name, the level held; the XP figure on the right.
  c.rect(0, 0, W, HEAD, BLUE);
  c.rect(0, HEAD, W, 8, YELLOW);
  c.text(X0, 22, `LAHTIAG BATTLE PASS ${input.season.replace('–', '-')}`, 0xffeba4, 's');
  c.text(X0, 52, Canvas.fit(cleanText(input.name), W - 80 - 300, 'l'), WHITE, 'l');
  const standing = progress.current ? levelTitle(progress.current) : levels.length === 0 ? 'Levels come in the autumn' : 'No level yet';
  c.text(X0, 110, Canvas.fit(cleanText(standing), W - 80 - 300), WHITE, 's');
  xpFigure(c, W - X0, 30, progress.xp);

  // The bar to the next rung, with what is missing said under it.
  const barW = W - 2 * X0;
  c.rect(X0, BAR_TOP, barW, 14, LIGHT);
  const filled = Math.round(barW * (levels.length === 0 ? 0 : progress.fraction));
  if (filled > 0) c.rect(X0, BAR_TOP, filled, 14, progress.next ? BLUE : YELLOW);
  const under = progress.next
    ? `${progress.to_next} XP to ${levelTitle(progress.next)}`
    : levels.length === 0
      ? 'Your XP counts already'
      : 'Every level of the season reached';
  c.text(X0, BAR_TOP + 22, Canvas.fit(cleanText(under), barW - (pages > 1 ? 140 : 0)), INK, 's');
  if (pages > 1) {
    const label = `PAGE ${p} / ${pages}`;
    c.text(W - X0 - Canvas.textWidth(label), BAR_TOP + 22, label, GRAY, 's');
  }

  // The rungs: number or tick in a box, name and reward, the XP line on the right.
  let y = ROWS_TOP;
  for (const l of rows) {
    const h = rowHeight(l);
    const done = l.xp <= progress.xp || input.held.includes(l.id);
    const next = progress.next?.id === l.id;
    c.rect(X0, y, barW, h, next ? PALE : WHITE);
    c.rect(X0, y, 6, h, done ? YELLOW : next ? BLUE : LIGHT);
    // The box: filled for a reached rung, outlined for the rest.
    const bx = X0 + 24;
    const by = y + 17;
    if (done) {
      c.rect(bx, by, 44, 44, BLUE);
      c.glyph(bx + 12, by + 16, TICK, WHITE, 2);
    } else {
      c.rect(bx, by, 44, 44, next ? BLUE : LIGHT);
      c.rect(bx + 2, by + 2, 40, 40, next ? PALE : WHITE);
      const n = String(l.level);
      c.text(bx + 22 - Canvas.textWidth(n) / 2, by + 5, n, next ? BLUE : GRAY, 's');
    }
    // Name and reward, the XP line top right, and the sponsor's name on
    // a line of its own when there is one.
    const tx = bx + 66;
    const ink = done || next ? INK : GRAY;
    const xpText = `${l.xp} XP`;
    const xpW = Canvas.textWidth(xpText, 'l');
    const right = W - X0 - 24;
    const textW = right - xpW - 24 - tx;
    c.text(tx, y + 6, Canvas.fit(cleanText(l.name), textW, 'l'), ink, 'l');
    c.text(tx, y + 46, Canvas.fit(cleanText(l.reward), right - tx), ink, 's');
    c.text(right - xpW, y + 14, xpText, done ? BLUE : ink, 'l');
    if (l.sponsor) c.text(tx, y + 72, Canvas.fit(cleanText(`from ${l.sponsor}`), right - tx), done || next ? GRAY : LIGHT, 's');
    y += h + ROW_GAP;
  }
  if (rows.length === 0) {
    const y = ROWS_TOP;
    c.rect(X0, y, barW, ROW_H, WHITE);
    c.rect(X0, y, 6, ROW_H, LIGHT);
    c.text(X0 + 24, y + 22, Canvas.fit('The board sets the levels in the autumn.', barW - 48), GRAY, 's');
  }

  // Footer: the site, and how many rungs the season has.
  const fy = H - FOOT + 18;
  const total = levels.length === 0 ? '' : `${levels.filter((l) => l.xp <= progress.xp || input.held.includes(l.id)).length} of ${levels.length} levels reached`;
  c.text(X0, fy, total, INK, 's');
  const siteW = Canvas.textWidth('lahtiag.fi/membership');
  c.text(W - X0 - siteW, fy, 'lahtiag.fi/membership', GRAY, 's');
  return c.png();
}
