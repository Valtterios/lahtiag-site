// A member's season so far, for the membership page and the /season
// command: events attended, Discord activity, Minecraft play time. The
// XP and levels of the season pass will be computed from these once the
// board has settled the rules; until then the raw numbers show. The season
// is the academic year, from 1 September (see activity.ts).
import type { D1Database } from '@cloudflare/workers-types';
import { seasonActivity, seasonLabel, seasonStartYear, voiceLabel } from './activity';
import { seasonPlaytime } from './playtime';
import { listMinecraftNames } from './minecraft';
import { memberSeasonTicks, tickList, tickXp, type SeasonTick } from './ticks';
import { helsinkiToUnix } from './time';

export interface SeasonSummary {
  label: string; // '2026–27'
  events: number;
  messages: number;
  voice_minutes: number;
  playtime: { server: string; label: string; minutes: number }[];
  minecraft_name: string | null; // the member's own whitelisted name, if any
  ticks: SeasonTick[]; // what the board noted by hand (src/lib/ticks.ts)
  tick_xp: number; // what those are worth, caps applied
}

export function seasonStartUnix(now: number): number {
  return helsinkiToUnix(`${seasonStartYear(now)}-09-01`, '00:00') ?? now;
}

// Events attended this season: signed up as going, or holding a paid
// ticket, to a published event that has started (same reading as the
// all-time stats on the membership page).
export async function seasonEvents(db: D1Database, discordId: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
       WHERE e.cancelled_at IS NULL AND e.published_at IS NOT NULL AND e.starts_at >= ?3 AND e.starts_at < ?2
         AND (EXISTS (SELECT 1 FROM signups s WHERE s.event_id = e.id AND s.discord_id = ?1 AND s.status = 'yes')
           OR EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.discord_id = ?1 AND t.status = 'paid'))`,
    )
    .bind(discordId, now, seasonStartUnix(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function seasonSummary(db: D1Database, discordId: string, now: number): Promise<SeasonSummary> {
  const [events, activity, playtime, names, ticks] = await Promise.all([
    seasonEvents(db, discordId, now),
    seasonActivity(db, discordId, now),
    seasonPlaytime(db, discordId, now),
    listMinecraftNames(db, discordId),
    memberSeasonTicks(db, discordId, now),
  ]);
  return {
    label: seasonLabel(now),
    events,
    messages: activity.messages,
    voice_minutes: activity.voice_minutes,
    playtime,
    minecraft_name: names.find((n) => n.kind === 'own')?.name ?? null,
    ticks,
    tick_xp: tickXp(ticks),
  };
}

// The Minecraft line: the time played under the member's own name, or the
// reason there is none. Play under a name that isn't theirs counts for
// nobody, which is the thing to say before it discourages anyone.
export function minecraftLine(summary: SeasonSummary, how: string): string {
  const played = summary.playtime.filter((p) => p.minutes > 0);
  if (!summary.minecraft_name) return `No Minecraft name is linked to you, so play on the servers isn't counted for you yet. ${how}`;
  if (played.length === 0) return `No play time yet under ${summary.minecraft_name}.`;
  return `${played.map((p) => `${p.label} ${voiceLabel(p.minutes)}`).join(' · ')}, as ${summary.minecraft_name}.`;
}

// The lines the /season command answers with.
export function seasonLines(summary: SeasonSummary, origin: string): string {
  return [
    `**Your season ${summary.label}** so far`,
    `📅 Events attended: **${summary.events}**`,
    `💬 Discord: **${summary.messages}** messages · **${voiceLabel(summary.voice_minutes)}** in voice`,
    `⛏️ Minecraft: ${minecraftLine(summary, '`/whitelist me <name>` fixes that.')}`,
    ...(summary.ticks.length > 0
      ? [`✅ Ticks from the board: **${summary.ticks.length}** · ${tickList(summary.ticks)}${summary.tick_xp > 0 ? ` · **${summary.tick_xp} XP**` : ''}`]
      : []),
    `The season pass and its levels come once the board has set the rules. More on ${origin}/membership`,
  ].join('\n');
}
