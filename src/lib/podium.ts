// The end of a bracket: who finished first, second and third.
//
// Third place is only a fact when it was played for. A bracket with a
// bronze match has one; without it, two teams lost in the semifinals and
// neither is third, so the podium says so rather than inventing one.

import type { BracketMatch } from './db';

// The final is slot 0 of the last round; the bronze match sits beside it.
export const FINAL_SLOT = 0;
export const BRONZE_SLOT = 1;

export const GOLD = '🥇';
export const SILVER = '🥈';
export const BRONZE = '🥉';

export function totalRoundsOf(matches: BracketMatch[]): number {
  return matches.reduce((max, m) => Math.max(max, m.round), 0);
}

export function isBronzeMatch(match: Pick<BracketMatch, 'round' | 'slot'>, totalRounds: number): boolean {
  return totalRounds >= 2 && match.round === totalRounds && match.slot === BRONZE_SLOT;
}

export function isFinal(match: Pick<BracketMatch, 'round' | 'slot'>, totalRounds: number): boolean {
  return match.round === totalRounds && match.slot === FINAL_SLOT;
}

// The two who lost the semifinals, in slot order: the bronze match's
// sides. Null for a semifinal that is still undecided.
export function semifinalLosers(matches: BracketMatch[], totalRounds: number): [string | null, string | null] {
  const loserOf = (slot: number): string | null => {
    const m = matches.find((x) => x.round === totalRounds - 1 && x.slot === slot);
    if (!m?.winner || m.side_a === null || m.side_b === null) return null;
    return m.winner === m.side_a ? m.side_b : m.side_a;
  };
  return [loserOf(0), loserOf(1)];
}

export interface Podium {
  gold: string;
  silver: string;
  bronze: string | null; // null when no bronze match was played, or it is undecided
}

// Null until the final is decided: there is no podium before then.
export function podiumOf(matches: BracketMatch[]): Podium | null {
  const total = totalRoundsOf(matches);
  const final = matches.find((m) => isFinal(m, total));
  if (!final?.winner || final.side_a === null || final.side_b === null) return null;
  const bronze = matches.find((m) => isBronzeMatch(m, total));
  return {
    gold: final.winner,
    silver: final.winner === final.side_a ? final.side_b : final.side_a,
    bronze: bronze?.winner ?? null,
  };
}

// The podium as one line, for the bot and the pinned bracket. `champion`
// names the top place in words — the pinned bracket has always said
// "Champion" and losing that to a bare medal would read as less, not more.
export function podiumLine(podium: Podium, nameOf: (key: string) => string, champion = false): string {
  const places = [`${GOLD} ${champion ? 'Champion: ' : ''}**${nameOf(podium.gold)}**`, `${SILVER} ${nameOf(podium.silver)}`];
  if (podium.bronze) places.push(`${BRONZE} ${nameOf(podium.bronze)}`);
  return places.join(' · ');
}
