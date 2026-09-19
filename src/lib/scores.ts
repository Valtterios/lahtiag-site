// Best-of matches: how many games decide one, which scorelines can end
// it, and how a score reads. A bracket is best-of-one unless the board
// says otherwise, and its final may be longer than the rest.
//
// Everything here is pure: the bracket page, the picture, the bot's lines
// and the panel all ask the same questions of it.

export const BEST_OF_CHOICES = [1, 3, 5, 7] as const;

export function isBestOf(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 9 && n % 2 === 1;
}

export interface BracketFormat {
  best_of: number;
  final_best_of: number | null;
}

// What this round is played to. The final takes the override when there
// is one; everything else takes the bracket's own length.
export function bestOfFor(bracket: BracketFormat, round: number, totalRounds: number): number {
  const override = round === totalRounds && round > 0 ? bracket.final_best_of : null;
  return override ?? bracket.best_of ?? 1;
}

// Games one side has to win: 2 of a best-of-three.
export function winsNeeded(bestOf: number): number {
  return (bestOf + 1) / 2;
}

// Every way a best-of can end, as [winner's games, loser's games], the
// sweep first. A best-of-three: 2–0, then 2–1.
export function scorelines(bestOf: number): [number, number][] {
  const need = winsNeeded(bestOf);
  return Array.from({ length: need }, (_, i) => [need, i] as [number, number]);
}

export function isLegalScore(bestOf: number, winnerGames: number, loserGames: number): boolean {
  return scorelines(bestOf).some(([w, l]) => w === winnerGames && l === loserGames);
}

// "2–1", with an en dash, or null when the match has no score to show —
// a best-of-one, or a result recorded without one.
export function scoreText(a: number | null | undefined, b: number | null | undefined): string | null {
  return a === null || a === undefined || b === null || b === undefined ? null : `${a}–${b}`;
}

// The score as the two sides hold it, from the winner's point of view.
export function sidesOf(
  winnerIsA: boolean,
  score: [number, number] | null,
): { score_a: number | null; score_b: number | null } {
  if (!score) return { score_a: null, score_b: null };
  const [won, lost] = score;
  return winnerIsA ? { score_a: won, score_b: lost } : { score_a: lost, score_b: won };
}

// "2-1" as a scoreline button or a slash argument writes it, read as
// [winner's games, loser's games]. Anything unparseable is no score at
// all — the winner is still recorded — and a score that does not fit the
// format is refused where it is written, not here.
export function parseScore(raw: unknown): [number, number] | null {
  const match = /^\s*(\d{1,2})\s*[-–:]\s*(\d{1,2})\s*$/.exec(String(raw ?? ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
}
