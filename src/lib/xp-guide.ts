// How XP is earned and what a member has collected: the answer to /xp
// and to the "How to earn XP" button under /pass and /season. The ways
// are the tick kinds the board keeps (src/lib/ticks.ts), with what each
// pays and how many count; the collected part is the member's own ticks
// this season, each marked counted or over its cap. Events, Discord and
// Minecraft are counted already but pay nothing until the board says
// what they are worth, and that is said plainly rather than left out.
import { applyCaps, TICK_PERIOD_LABELS, type SeasonTick, type TickKind } from './ticks';
import type { SeasonSummary } from './season';
import { formatHelsinkiDate } from './time';
import { voiceLabel } from './activity';

// "100 XP, up to 1 per season" / "30 XP, every one counts".
export function kindTerms(kind: Pick<TickKind, 'xp' | 'season_cap' | 'period'>): string {
  const cap = kind.season_cap === 0 ? 'every one counts' : `up to ${kind.season_cap} ${TICK_PERIOD_LABELS[kind.period]}`;
  return `${kind.xp} XP, ${cap}`;
}

export function waysLines(kinds: TickKind[]): string[] {
  const live = kinds.filter((k) => k.retired_at === null && k.xp > 0);
  if (live.length === 0) return ['The board has not put any XP on the list yet.'];
  return live.map((k) => `• **${k.name}** — ${kindTerms(k)}${k.claimable ? ' · you can claim it' : ''}${k.description ? `\n  ${k.description}` : ''}`);
}

// A member's ticks this season, oldest first, with what each paid.
export function collectedLines(ticks: SeasonTick[]): string[] {
  if (ticks.length === 0) return ['Nothing yet. The first tick starts it.'];
  return applyCaps(ticks, (t) => t).map((t) => {
    const what = t.event ? `${t.kind} (${t.event})` : t.kind;
    return t.counted ? `✅ ${formatHelsinkiDate(t.given_at)} · ${what} · **${t.xp} XP**` : `▫️ ${formatHelsinkiDate(t.given_at)} · ${what} · over the cap, 0 XP`;
  });
}

export function xpGuideLines(kinds: TickKind[], summary: SeasonSummary, origin: string): string {
  const claimable = kinds.some((k) => k.retired_at === null && k.claimable);
  return [
    `**How to earn XP · season ${summary.label}**`,
    ...waysLines(kinds),
    `📅 Events (${summary.events} attended), 💬 Discord (${summary.messages} messages, ${voiceLabel(summary.voice_minutes)} in voice) and ⛏️ Minecraft are counted, and pay XP once the board has set what they are worth.`,
    '',
    `**Collected so far: ${summary.tick_xp} XP**`,
    ...collectedLines(summary.ticks),
    ...(summary.claims_pending > 0 ? [`⏳ ${summary.claims_pending} claim${summary.claims_pending === 1 ? '' : 's'} waiting for the board.`] : []),
    `${claimable ? '`/claim` asks the board for a tick · ' : ''}\`/pass\` shows the levels · ${origin}/membership#pass`,
  ].join('\n');
}
