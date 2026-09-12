// The betting board as a picture: one block per pool (the tournament
// winner, then each match with stakes on it), a bar per side showing its
// share of the pool, the stake, the backers and what it pays. Drawn like
// the pass (src/lib/raster.ts) for /odds in Discord and the event page.
import { Canvas, cleanText } from './raster';
import { WINNER, type Odds, type Market } from './coins';

const BLUE = 0x4169e1;
const YELLOW = 0xffde59;
const INK = 0x1e1e1e;
const GRAY = 0x868686;
const LIGHT = 0xdcdcdc;
const BG = 0xf5f5f5;
const WHITE = 0xffffff;
const GREEN = 0x2f9e5b;

const W = 900;
const HEAD = 110;
const X0 = 40;
const POOL_HEAD = 100;
const ROW_H = 96;
const ROW_GAP = 8;
const POOL_GAP = 22;
const FOOT = 56;

export interface PoolInput {
  market: Market;
  odds: Odds;
  label: string; // 'Tournament winner' or 'ggez vs ygygivers'
}

export interface OddsCardInput {
  title: string;
  pools: PoolInput[];
  nameOf: (key: string) => string;
}

function stateLabel(m: Market): string {
  return m.settled_at !== null ? 'PAID OUT' : m.closed_at !== null ? 'LOCKED' : 'OPEN';
}

function payLabel(multiplier: number | null): string {
  if (multiplier === null) return '';
  return `pays ${multiplier >= 10 ? Math.round(multiplier) : multiplier.toFixed(1)}x`;
}

export function oddsCardHeight(pools: PoolInput[]): number {
  const body = pools.reduce((h, p) => h + POOL_HEAD + Math.max(1, p.odds.picks.length) * (ROW_H + ROW_GAP) - ROW_GAP + POOL_GAP, 0) - (pools.length > 0 ? POOL_GAP : 0);
  return HEAD + 24 + (pools.length === 0 ? ROW_H : body) + FOOT;
}

export async function oddsCardPng(input: OddsCardInput): Promise<Uint8Array> {
  const H = oddsCardHeight(input.pools);
  const c = new Canvas(W, H, BG);
  c.rect(0, 0, W, HEAD, BLUE);
  c.rect(0, HEAD, W, 8, YELLOW);
  c.text(X0, 20, 'LAHTIAG BETTING BOARD', 0xffeba4, 's');
  c.text(X0, 50, Canvas.fit(cleanText(input.title), W - 2 * X0, 'l'), WHITE, 'l');
  const total = input.pools.reduce((n, p) => n + p.odds.pool, 0);
  const totalText = `${total} coins in play`;
  c.text(W - X0 - Canvas.textWidth(totalText), 22, totalText, 0xffeba4, 's');

  let y = HEAD + 24;
  const barW = W - 2 * X0;
  if (input.pools.length === 0) {
    c.rect(X0, y, barW, ROW_H, WHITE);
    c.text(X0 + 20, y + 18, 'Betting opens when the bracket goes live.', GRAY, 's');
  }
  for (const p of input.pools) {
    const m = p.market;
    const state = stateLabel(m);
    c.text(X0, y + 2, Canvas.fit(cleanText(p.label), barW, 'l'), INK, 'l');
    const under = `${state} · ${p.odds.pool} ${p.odds.pool === 1 ? 'coin' : 'coins'} in the pool from ${p.odds.bets}`;
    c.text(X0, y + 58, Canvas.fit(under, barW), state === 'OPEN' ? GREEN : GRAY, 's');
    y += POOL_HEAD;
    if (p.odds.picks.length === 0) {
      c.rect(X0, y, barW, ROW_H, WHITE);
      c.rect(X0, y, 6, ROW_H, LIGHT);
      c.text(X0 + 24, y + 30, 'No stakes yet', GRAY, 's');
      y += ROW_H;
    }
    for (const pick of p.odds.picks) {
      const won = m.winner !== null && m.winner === pick.pick;
      const lost = m.winner !== null && m.winner !== pick.pick;
      c.rect(X0, y, barW, ROW_H, WHITE);
      // The bar: this side's share of the pool, the whole width being all of it.
      const fill = Math.max(8, Math.round((barW - 12) * pick.share));
      c.rect(X0 + 6, y + ROW_H - 12, barW - 12, 8, LIGHT);
      c.rect(X0 + 6, y + ROW_H - 12, fill, 8, won ? YELLOW : lost ? LIGHT : BLUE);
      c.rect(X0, y, 6, ROW_H, won ? YELLOW : lost ? LIGHT : BLUE);
      const name = cleanText(input.nameOf(pick.pick));
      const pay = won ? payLabel(pick.multiplier).replace('pays', 'paid') : payLabel(pick.multiplier);
      const payW = Canvas.textWidth(pay, 'l');
      c.text(X0 + 24, y + 4, Canvas.fit(name, barW - 24 - payW - 40, 'l'), lost ? GRAY : INK, 'l');
      c.text(W - X0 - 18 - payW, y + 4, pay, won ? INK : lost ? LIGHT : BLUE, 'l');
      const detail = `${pick.staked} coins from ${pick.backers} · ${Math.round(pick.share * 100)}% of the pool`;
      c.text(X0 + 24, y + 54, Canvas.fit(detail, barW - 48), GRAY, 's');
      y += ROW_H + ROW_GAP;
    }
    y += POOL_GAP - ROW_GAP;
  }
  const fy = H - FOOT + 16;
  c.text(X0, fy, Canvas.fit('/bet <team or player> <coins> · me works as a pick', W - 2 * X0), GRAY, 's');
  return c.png();
}

// The label a match pool shows: the two sides.
export function poolLabel(scope: string, sides: { a: string; b: string } | null): string {
  return scope === WINNER ? 'Tournament winner' : sides ? `${sides.a} vs ${sides.b}` : 'A match';
}
