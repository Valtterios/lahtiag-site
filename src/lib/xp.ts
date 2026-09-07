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
  username: string | null; // the cached Discord name, when the member has used the site or the bot
  handle: string | null; // the Discord name on their register entry, the fallback
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
      `SELECT t.kind_id, t.given_at, t.xp, k.season_cap, k.period, r.discord_id, r.discord_name
       FROM ticks t
       JOIN tick_kinds k ON k.id = t.kind_id
       JOIN register r ON r.id = t.register_id
       WHERE r.discord_id IS NOT NULL AND r.status = 'member' AND t.given_at >= ?1 AND t.given_at < ?2`,
    )
    .bind(from, to)
    .all<{ kind_id: number; given_at: number; xp: number; season_cap: number; period: TickPeriod; discord_id: string; discord_name: string | null }>();
  const byMember = new Map<string, typeof results>();
  const handles = new Map<string, string | null>();
  for (const row of results) {
    byMember.set(row.discord_id, [...(byMember.get(row.discord_id) ?? []), row]);
    handles.set(row.discord_id, row.discord_name);
  }
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
    .map((id) => ({ discord_id: id, username: names.get(id)?.username ?? null, handle: handles.get(id) ?? null, xp: totals.get(id) ?? 0, hidden: names.get(id)?.hidden ?? false, rank: 0 }))
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

// A name to print inside the table (no mentions render in a code block):
// the cached Discord name, else the handle on the register entry.
export function shownName(s: Standing): string {
  return s.username ?? s.handle ?? `member …${s.discord_id.slice(-4)}`;
}

const NAME_WIDTH = 16;

// The scoreboard as a monospace table, for the embed.
export function leaderboardTable(standings: Standing[], limit = 10): string {
  const top = standings.filter((s) => !s.hidden).slice(0, limit);
  if (top.length === 0) return 'No XP yet this season. The first ticks decide it.';
  const xpWidth = Math.max(2, ...top.map((s) => String(s.xp).length));
  const lines = top.map((s) => {
    const name = [...shownName(s)].slice(0, NAME_WIDTH).join('');
    return `${String(s.rank).padStart(2)}  ${name.padEnd(NAME_WIDTH)}  ${String(s.xp).padStart(xpWidth)} XP`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

// The reader's own line under the table, when they are not in it. The
// message is public, so a hidden member's numbers stay out of it;
// /season has them.
export function ownLine(standings: Standing[], callerId: string | null, limit = 10): string | null {
  if (!callerId) return null;
  const top = standings.filter((s) => !s.hidden).slice(0, limit);
  if (top.some((s) => s.discord_id === callerId)) return null;
  const me = standings.find((s) => s.discord_id === callerId);
  if (me && !me.hidden) return `You: #${me.rank} with ${me.xp} XP.`;
  if (me) return 'You: hidden from the list, as you chose on your membership page. `/season` shows your XP.';
  return 'You: no XP yet. `/season` shows what counts.';
}

// The public message: one embed, the brand blue, the table in it.
export function leaderboardEmbed(standings: Standing[], callerId: string | null, now: number, limit = 10): unknown {
  const own = ownLine(standings, callerId, limit);
  return {
    title: `🏆 Season ${seasonLabel(now)} leaderboard`,
    description: `${leaderboardTable(standings, limit)}${own ? `\n${own}` : ''}`,
    color: 0x2b5cff,
    footer: { text: XP_NOTE },
  };
}
