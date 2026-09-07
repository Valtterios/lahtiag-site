// The season's XP: what the pass pays, per member, and the leaderboard
// built from it. For now the XP is the ticks (src/lib/ticks.ts); events,
// Discord activity and Minecraft play join here once the board has set
// the rules, computed from the per-day counts the same way, so nothing
// here changes shape then. The leaderboard honours the opt-out members
// already have for the history page (members.leaderboard_hidden).
import type { D1Database } from '@cloudflare/workers-types';
import { applyCaps, seasonRange, type TickPeriod } from './ticks';
import { seasonLabel, seasonStartYear } from './activity';

export interface Standing {
  discord_id: string;
  username: string | null; // the cached Discord name, when the member has signed in to the site
  xp: number;
  hidden: boolean; // opted out of leaderboards
  rank: number; // 1-based, ties share a rank
}

export const XP_NOTE = 'XP from ticks so far; events, Discord and Minecraft join once the board has set the rules.';

// Everyone with XP this season, most first, ranked. Hidden members are in
// the list (their own rank is theirs to see) and left out of what is
// shown to others.
export async function xpStandings(db: D1Database, now: number): Promise<Standing[]> {
  const { from, to } = seasonRange(seasonStartYear(now));
  const { results } = await db
    .prepare(
      `SELECT t.kind_id, t.given_at, t.xp, k.season_cap, k.period, r.discord_id
       FROM ticks t
       JOIN tick_kinds k ON k.id = t.kind_id
       JOIN register r ON r.id = t.register_id
       WHERE r.discord_id IS NOT NULL AND r.status = 'member' AND t.given_at >= ?1 AND t.given_at < ?2`,
    )
    .bind(from, to)
    .all<{ kind_id: number; given_at: number; xp: number; season_cap: number; period: TickPeriod; discord_id: string }>();
  const byMember = new Map<string, typeof results>();
  for (const row of results) byMember.set(row.discord_id, [...(byMember.get(row.discord_id) ?? []), row]);
  const totals = new Map<string, number>();
  for (const [id, rows] of byMember) {
    totals.set(
      id,
      applyCaps(rows, (t) => t).reduce((sum, t) => sum + (t.counted ? t.xp : 0), 0),
    );
  }
  const ids = [...totals.keys()];
  const names = new Map<string, { username: string; hidden: boolean }>();
  if (ids.length > 0) {
    const { results: members } = await db
      .prepare(`SELECT discord_id, username, leaderboard_hidden FROM members WHERE discord_id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ discord_id: string; username: string; leaderboard_hidden: number }>();
    for (const m of members) names.set(m.discord_id, { username: m.username, hidden: m.leaderboard_hidden === 1 });
  }
  const rows = ids
    .map((id) => ({ discord_id: id, username: names.get(id)?.username ?? null, xp: totals.get(id) ?? 0, hidden: names.get(id)?.hidden ?? false, rank: 0 }))
    .filter((r) => r.xp > 0)
    // Ties: by name, the ones with a cached name first.
    .sort((a, b) => b.xp - a.xp || Number(a.username === null) - Number(b.username === null) || (a.username ?? '').localeCompare(b.username ?? ''));
  let rank = 0;
  rows.forEach((r, i) => {
    if (i === 0 || r.xp < rows[i - 1].xp) rank = i + 1;
    r.rank = rank;
  });
  return rows;
}

// A name to print: the cached Discord name, else a mention (which the
// client renders as the name; the message is posted without pings).
function shown(s: Standing): string {
  return s.username ? `**${s.username}**` : `<@${s.discord_id}>`;
}

// The public message: the top of the season, then the reader's own line
// when they are not in it. The message is public, so a hidden member's
// numbers stay out of it; /season has them.
export function leaderboardText(standings: Standing[], callerId: string | null, now: number, limit = 10): string {
  const visible = standings.filter((s) => !s.hidden);
  const top = visible.slice(0, limit);
  const lines = [`🏆 **Season ${seasonLabel(now)} leaderboard**`];
  if (top.length === 0) lines.push('No XP yet this season. The first ticks decide it.');
  for (const s of top) lines.push(`${s.rank}. ${shown(s)} · ${s.xp} XP`);
  const me = callerId ? standings.find((s) => s.discord_id === callerId) : null;
  if (callerId && !top.some((s) => s.discord_id === callerId)) {
    if (me && !me.hidden) lines.push(`You: #${me.rank} with ${me.xp} XP.`);
    else if (me) lines.push('You: hidden from the list, as you chose on your membership page. `/season` shows your XP.');
    else lines.push('You: no XP yet. `/season` shows what counts.');
  }
  lines.push(`_${XP_NOTE}_`);
  return lines.join('\n');
}
