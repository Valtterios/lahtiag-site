// A member's stats as a picture, the way the bracket is drawn: for the
// membership page and for /profile on Discord, where everyone sees it.

import type { MemberStats } from './db';
import { Canvas } from './raster';
import { formatHelsinkiDate } from './time';

const BLUE = 0x4169e1;
const YELLOW = 0xffde59;
const INK = 0x1e1e1e;
const GRAY = 0x868686;
const BG = 0xf5f5f5;
const WHITE = 0xffffff;
const W = 900;
const H = 420;


export async function profileCardPng(name: string, stats: MemberStats): Promise<Uint8Array> {
  const c = new Canvas(W, H, BG);
  // Header band with the name.
  c.rect(0, 0, W, 150, BLUE);
  c.rect(0, 150, W, 8, YELLOW);
  c.text(40, 22, 'LahtiAG', 0xffeba4, 's');
  c.text(40, 52, Canvas.fit(name, W - 80, 'l'), WHITE, 'l');
  const since = stats.member_since !== null ? `Member since ${formatHelsinkiDate(stats.member_since)}` : 'Not a member yet';
  c.text(40, 110, since, WHITE, 's');

  // Three tiles.
  const tiles: [string, number][] = [
    ['EVENTS', stats.attended],
    ['TOURNAMENTS', stats.tournaments],
    ['WINS', stats.wins],
  ];
  const tileW = 260;
  const gap = 20;
  const x0 = 40;
  tiles.forEach(([label, value], i) => {
    const x = x0 + i * (tileW + gap);
    c.rect(x, 190, tileW, 150, WHITE);
    c.rect(x, 190, 6, 150, i === 2 && value > 0 ? YELLOW : BLUE);
    c.text(x + 24, 200, String(value), INK, 'xl');
    c.text(x + 24, 300, label, GRAY, 's');
  });

  // Footer: the last win, or the first event, and the site.
  const foot = stats.last_win
    ? `Last win: ${stats.last_win.title} (${formatHelsinkiDate(stats.last_win.starts_at)})`
    : stats.first_event_at !== null
      ? `First event: ${formatHelsinkiDate(stats.first_event_at)}`
      : 'No events yet. See you at the next one!';
  const siteW = Canvas.textWidth('lahtiag.fi');
  c.text(40, 366, Canvas.fit(foot, W - 80 - siteW - 30), INK, 's');
  c.text(W - 40 - siteW, 366, 'lahtiag.fi', GRAY, 's');
  return c.png();
}
