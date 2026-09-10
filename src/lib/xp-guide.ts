// How XP is earned and what a member has collected: the answer to /xp
// and to the "How to earn XP" button under /pass and /season. The ways
// are the tick kinds the board keeps (src/lib/ticks.ts), with what each
// pays and how many count; the collected part is the member's own ticks
// this season, each marked counted or over its cap. Events, Discord and
// Minecraft are counted already but pay nothing until the board says
// what they are worth, and that is said plainly rather than left out.
import { applyCaps, TICK_PERIOD_LABELS, type SeasonTick, type TickKind } from './ticks';
import { countLabel } from './auto-ticks';
import type { SeasonSummary } from './season';
import { formatHelsinkiDate } from './time';
import { voiceLabel } from './activity';

// "100 XP, up to 1 per season" / "30 XP, every one counts" / "20 XP per
// 1 h on Minecraft, up to 10 per week".
export function kindTerms(kind: Pick<TickKind, 'xp' | 'season_cap' | 'period' | 'auto_source' | 'auto_step'>): string {
  const cap = kind.season_cap === 0 ? 'every one counts' : `up to ${kind.season_cap} ${TICK_PERIOD_LABELS[kind.period]}`;
  if (kind.auto_source === 'events') return `${kind.xp} XP per event attended, ${cap}`;
  if (kind.auto_source) return `${kind.xp} XP per ${countLabel(kind.auto_source, kind.auto_step)}, ${cap}`;
  return `${kind.xp} XP, ${cap}`;
}

// One line a kind, its description as small print under it.
export function waysLines(kinds: TickKind[]): string[] {
  const live = kinds.filter((k) => k.retired_at === null && k.xp > 0);
  if (live.length === 0) return ['The board has not put any XP on the list yet.'];
  return live.map((k) => `• **${k.name}** · ${kindTerms(k)}${k.auto_source ? '' : k.claimable ? ' · claimable' : ''}${k.description ? `\n-# ${k.description}` : ''}`);
}

// A member's ticks this season, oldest first, with what each paid.
export function collectedLines(ticks: SeasonTick[]): string[] {
  if (ticks.length === 0) return ['Nothing yet. The first tick starts it.'];
  return applyCaps(ticks, (t) => t).map((t) => {
    const what = t.event ? `${t.kind} (${t.event})` : t.kind;
    return t.counted ? `✅ ${what} · **${t.xp} XP** · ${formatHelsinkiDate(t.given_at)}` : `▫️ ${what} · over the cap · ${formatHelsinkiDate(t.given_at)}`;
  });
}

// The whole answer. No link in it: the Membership page button under
// it goes there, and a bare link would hang a preview card off the list.
export function xpGuideLines(kinds: TickKind[], summary: SeasonSummary): string {
  const claimable = kinds.some((k) => k.retired_at === null && k.claimable);
  const paying = kinds.some((k) => k.retired_at === null && k.auto_source);
  return [
    `## ✨ How to earn XP`,
    ...waysLines(kinds),
    ...(paying ? [] : [`-# Events (${summary.events} attended), Discord (${summary.messages} messages, ${voiceLabel(summary.voice_minutes)} in voice) and Minecraft are counted, and pay once the board has set what they are worth.`]),
    '',
    `## 🎫 Collected this season · ${summary.tick_xp} XP`,
    ...collectedLines(summary.ticks),
    ...(summary.claims_pending > 0 ? [`⏳ ${summary.claims_pending} claim${summary.claims_pending === 1 ? '' : 's'} waiting for the board`] : []),
    `-# ${claimable ? '/claim asks the board for a tick · ' : ''}/pass shows the levels`,
  ].join('\n');
}
