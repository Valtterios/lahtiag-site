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

// The ways still open to the member: one line a kind, its description
// as small print under it. A kind they already hold a tick of is not
// repeated here; it sits in the collected part with its terms, so the
// answer is theirs rather than the same list for everyone.
export function waysLines(kinds: TickKind[], have: SeasonTick[] = []): string[] {
  const held = new Set(have.map((t) => t.kind_id));
  const live = kinds.filter((k) => k.retired_at === null && k.xp > 0);
  if (live.length === 0) return ['The board has not put any XP on the list yet.'];
  const open = live.filter((k) => !held.has(k.id));
  if (open.length === 0) return ['You have a tick of every kind on the list. Keep going: the ones below still pay until their cap.'];
  return open.map((k) => `• **${k.name}** · ${kindTerms(k)}${k.auto_source ? '' : k.claimable ? ' · claimable' : ''}${k.description ? `\n-# ${k.description}` : ''}`);
}

// What the member has, grouped by kind: what it paid, how many counted
// and how many fell over the cap, the terms, and for event ticks the
// events. The kinds list supplies the terms; a tick of a retired kind
// falls back to what the tick itself carries.
export function collectedLines(ticks: SeasonTick[], kinds: TickKind[] = []): string[] {
  if (ticks.length === 0) return ['Nothing yet. The first tick starts it.'];
  const flagged = applyCaps(ticks, (t) => t);
  const byKind = new Map<number, typeof flagged>();
  for (const t of flagged) byKind.set(t.kind_id, [...(byKind.get(t.kind_id) ?? []), t]);
  return [...byKind.values()].map((group) => {
    const first = group[0];
    const kind = kinds.find((k) => k.id === first.kind_id);
    const counted = group.filter((t) => t.counted);
    const over = group.length - counted.length;
    const paid = counted.reduce((sum, t) => sum + t.xp, 0);
    const terms = kind ? kindTerms(kind) : `${first.xp} XP, ${first.season_cap === 0 ? 'every one counts' : `up to ${first.season_cap} ${TICK_PERIOD_LABELS[first.period]}`}`;
    const events = group.filter((t) => t.event).map((t) => t.event as string);
    const count = group.length === 1 ? '' : ` from ${counted.length}${over > 0 ? ` (+${over} over the cap)` : ''}`;
    const tail = events.length > 0 ? events.join(', ') : formatHelsinkiDate(group[group.length - 1].given_at);
    return `${paid > 0 ? '✅' : '▫️'} **${first.kind}** · **${paid} XP**${count} · ${terms} · ${tail}`;
  });
}

// The whole answer. No link in it: the Membership page button under
// it goes there, and a bare link would hang a preview card off the list.
export function xpGuideLines(kinds: TickKind[], summary: SeasonSummary): string {
  const claimable = kinds.some((k) => k.retired_at === null && k.claimable);
  const paying = kinds.some((k) => k.retired_at === null && k.auto_source);
  return [
    `## ✨ How to earn XP`,
    ...waysLines(kinds, summary.ticks),
    ...(paying ? [] : [`-# Events (${summary.events} attended), Discord (${summary.messages} messages, ${voiceLabel(summary.voice_minutes)} in voice) and Minecraft are counted, and pay once the board has set what they are worth.`]),
    '',
    `## 🎫 Collected this season · ${summary.tick_xp} XP`,
    ...collectedLines(summary.ticks, kinds),
    ...(summary.claims_pending > 0 ? [`⏳ ${summary.claims_pending} claim${summary.claims_pending === 1 ? '' : 's'} waiting for the board`] : []),
    `-# ${claimable ? '/claim asks the board for a tick · ' : ''}/pass shows the levels`,
  ].join('\n');
}
