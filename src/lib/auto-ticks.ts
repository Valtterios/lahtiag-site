// Ticks the bot gives by itself, from what the site already counts:
// play time on the Minecraft servers, time in voice, messages, events
// attended. The board makes a kind with a source and a step ("Played
// Minecraft for an hour": minecraft, 60 min, 20 XP), and the hourly job
// gives each member one tick per step their season total has crossed,
// or one per event attended. A tick given is an ordinary tick after
// that: the kind's cap decides whether it pays, the pass levels see it,
// /xp lists it. The general channel is told of what was paid, so a
// member knows the hour counted and so does everyone else; ticks over
// the cap are given quietly, since "you got 0 XP" is not news.
import type { D1Database } from '@cloudflare/workers-types';
import { applyCaps, seasonRange, AUTO_UNITS, listTickKinds, type TickKind, type AutoSource } from './ticks';
import { seasonDays, seasonStartYear, voiceLabel } from './activity';
import { dmUser, postWebhook, NO_MENTIONS, SUPPRESS_EMBEDS } from './discord';

export interface MemberTotal {
  register_id: number;
  discord_id: string;
  total: number; // minutes or messages this season
}

export interface Attendance {
  register_id: number;
  discord_id: string;
  event_id: number;
  title: string;
}

// Every current member's season total for a source, one query each.
export async function memberTotals(db: D1Database, source: Exclude<AutoSource, 'events'>, now: number): Promise<MemberTotal[]> {
  const { from, to } = seasonDays(now);
  const sql =
    source === 'minecraft'
      ? `SELECT r.id AS register_id, r.discord_id, SUM(p.minutes) AS total
         FROM minecraft_playtime p
         JOIN minecraft_names n ON n.uuid = p.uuid AND n.kind = 'own'
         JOIN register r ON r.discord_id = n.discord_id AND r.status = 'member'
         WHERE p.day BETWEEN ?1 AND ?2 GROUP BY r.id`
      : `SELECT r.id AS register_id, r.discord_id, SUM(a.${source === 'voice' ? 'voice_minutes' : 'messages'}) AS total
         FROM discord_activity a
         JOIN register r ON r.discord_id = a.discord_id AND r.status = 'member'
         WHERE a.day BETWEEN ?1 AND ?2 GROUP BY r.id`;
  const { results } = await db.prepare(sql).bind(from, to).all<MemberTotal>();
  return results.filter((r) => r.total > 0);
}

// Every (member, event) attended this season: a published event that has
// started, signed up as going or holding a paid ticket, the same reading
// as the season's event count.
export async function attendances(db: D1Database, now: number): Promise<Attendance[]> {
  const { from } = seasonRange(seasonStartYear(now));
  const { results } = await db
    .prepare(
      `SELECT r.id AS register_id, r.discord_id, e.id AS event_id, e.title
       FROM events e
       JOIN register r ON r.status = 'member' AND r.discord_id IS NOT NULL
       WHERE e.cancelled_at IS NULL AND e.published_at IS NOT NULL AND e.starts_at >= ?1 AND e.starts_at < ?2
         AND (EXISTS (SELECT 1 FROM signups s WHERE s.event_id = e.id AND s.discord_id = r.discord_id AND s.status = 'yes')
           OR EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.discord_id = r.discord_id AND t.status = 'paid'))`,
    )
    .bind(from, now)
    .all<Attendance>();
  return results;
}

export interface AutoTick {
  register_id: number;
  discord_id: string;
  kind: TickKind;
  xp: number; // what the tick paid, 0 when it fell over the cap
  total: number; // the season total that earned it (events: the event's id)
  event: string | null;
}

// How many ticks of one kind a member has this season: the steps
// already ticked.
async function haveTicks(db: D1Database, kindId: number, registerId: number, now: number): Promise<number> {
  const { from, to } = seasonRange(seasonStartYear(now));
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM ticks WHERE kind_id = ?1 AND register_id = ?2 AND given_at >= ?3 AND given_at < ?4')
    .bind(kindId, registerId, from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Gives what is due under every automatic kind and returns it. Running
// twice gives nothing the second time: steps already ticked stay ticked,
// and an event is ticked once (the unique index on ticks sees to it).
export async function giveAutoTicks(db: D1Database, now: number): Promise<AutoTick[]> {
  const kinds = (await listTickKinds(db)).filter((k) => k.auto_source !== null && k.xp > 0);
  const out: AutoTick[] = [];
  for (const kind of kinds) {
    if (kind.auto_source === 'events') {
      for (const a of await attendances(db, now)) {
        const result = await db
          .prepare(
            `INSERT OR IGNORE INTO ticks (kind_id, register_id, event_id, note, xp, given_by, given_at) VALUES (?1, ?2, ?3, NULL, ?4, 'bot', ?5)`,
          )
          .bind(kind.id, a.register_id, a.event_id, kind.xp, now)
          .run();
        if ((result.meta.changes ?? 0) > 0) out.push({ register_id: a.register_id, discord_id: a.discord_id, kind, xp: kind.xp, total: a.event_id, event: a.title });
      }
      continue;
    }
    const step = Math.max(1, kind.auto_step);
    for (const m of await memberTotals(db, kind.auto_source!, now)) {
      const due = Math.floor(m.total / step);
      const have = await haveTicks(db, kind.id, m.register_id, now);
      for (let i = have; i < due; i++) {
        const reached = (i + 1) * step;
        const note = `${countLabel(kind.auto_source!, reached)} this season`;
        await db
          .prepare(`INSERT INTO ticks (kind_id, register_id, event_id, note, xp, given_by, given_at) VALUES (?1, ?2, NULL, ?3, ?4, 'bot', ?5)`)
          .bind(kind.id, m.register_id, note, kind.xp, now)
          .run();
        out.push({ register_id: m.register_id, discord_id: m.discord_id, kind, xp: kind.xp, total: reached, event: null });
      }
    }
  }
  // What each paid: the member's ticks of the kind this season through
  // the caps, the new ones being the last given.
  for (const tick of out) {
    if (tick.kind.season_cap === 0) continue;
    const { from, to } = seasonRange(seasonStartYear(now));
    const { results } = await db
      .prepare('SELECT id, kind_id, given_at FROM ticks WHERE kind_id = ?1 AND register_id = ?2 AND given_at >= ?3 AND given_at < ?4 ORDER BY given_at, id')
      .bind(tick.kind.id, tick.register_id, from, to)
      .all<{ id: number; kind_id: number; given_at: number }>();
    const flagged = applyCaps(results, () => tick.kind);
    // The new ticks were given at `now`; the last of them is this one when
    // several were given at once, so count the counted ones among them.
    const mine = flagged.filter((t) => t.given_at === now);
    const index = out.filter((o) => o.kind.id === tick.kind.id && o.register_id === tick.register_id).indexOf(tick);
    tick.xp = mine[index]?.counted ? tick.kind.xp : 0;
  }
  return out;
}

export function countLabel(source: AutoSource, n: number): string {
  if (source === 'minecraft') return `${voiceLabel(n)} on Minecraft`;
  if (source === 'voice') return `${voiceLabel(n)} in voice`;
  if (source === 'messages') return `${n} messages`;
  return `${n} ${AUTO_UNITS.events}${n === 1 ? '' : 's'}`;
}

function safe(text: string): string {
  return text.replace(/[`*_~|>\[\]()@#]/g, '').trim();
}

// One line per member: what they reached and what it paid. Several ticks
// at once fold into it: each event named, and for a stepped kind the
// highest total reached, so two hours read as "2 h", not twice.
export function autoLine(name: string, ticks: AutoTick[]): string {
  const paid = ticks.reduce((sum, t) => sum + t.xp, 0);
  const parts: string[] = [];
  const topByKind = new Map<number, AutoTick>();
  for (const t of ticks) {
    if (t.event) parts.push(`${safe(t.kind.name)} (${safe(t.event)})`);
    else if ((topByKind.get(t.kind.id)?.total ?? 0) < t.total) topByKind.set(t.kind.id, t);
  }
  for (const t of topByKind.values()) parts.push(`${safe(t.kind.name)}, ${countLabel(t.kind.auto_source!, t.total)}`);
  return `✨ **${safe(name)}** got **${paid} XP**: ${parts.join(' · ')}.`;
}

export interface AutoEnv {
  DISCORD_BOT_TOKEN?: string;
  WELCOME_WEBHOOK_URL?: string;
}

// The hourly step: give what is due, then tell the general channel one
// line per member for what paid; a member hidden from the leaderboard
// hears by DM instead. Returns how many members were told.
export async function announceAutoTicks(db: D1Database, env: AutoEnv, origin: string, now: number): Promise<number> {
  const given = await giveAutoTicks(db, now);
  const byMember = new Map<string, AutoTick[]>();
  for (const t of given) if (t.xp > 0) byMember.set(t.discord_id, [...(byMember.get(t.discord_id) ?? []), t]);
  if (byMember.size === 0) return 0;
  const ids = [...byMember.keys()];
  const { results } = await db
    .prepare(`SELECT r.discord_id, m.username, m.leaderboard_hidden, r.discord_name FROM register r LEFT JOIN members m ON m.discord_id = r.discord_id WHERE r.discord_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ discord_id: string; username: string | null; leaderboard_hidden: number | null; discord_name: string | null }>();
  let told = 0;
  for (const [id, ticks] of byMember) {
    const who = results.find((r) => r.discord_id === id);
    const name = who?.username ?? who?.discord_name ?? `member …${id.slice(-4)}`;
    const line = autoLine(name, ticks);
    if (who?.leaderboard_hidden === 1) {
      if (env.DISCORD_BOT_TOKEN && (await dmUser(env.DISCORD_BOT_TOKEN, id, `${line}\nYou are hidden from the leaderboard, so the server was not told. ${origin}/membership#pass`))) told++;
      continue;
    }
    if (env.WELCOME_WEBHOOK_URL && (await postWebhook(env.WELCOME_WEBHOOK_URL, line, NO_MENTIONS, SUPPRESS_EMBEDS)) !== null) told++;
  }
  return told;
}
