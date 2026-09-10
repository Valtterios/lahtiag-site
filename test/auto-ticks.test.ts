import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { giveAutoTicks, announceAutoTicks, autoLine, countLabel, memberTotals, attendances } from '../src/lib/auto-ticks';
import { addTickKind, listTickKinds } from '../src/lib/ticks';
import { seasonSummary } from '../src/lib/season';
import { RuleError } from '../src/lib/db';

// The bot's own ticks: what the season's counts have earned, given once,
// through the caps, and told to the channel.

const NOW = Date.UTC(2026, 8, 7, 12) / 1000; // 7 September 2026
const AINO = '100000000000000001';
const BO = '100000000000000002';
const UUID = '11111111-1111-1111-1111-111111111111';

async function member(name: string, discordId: string | null, status = 'member'): Promise<number> {
  const result = await env.DB
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, discord_name, status, source, applied_at, consented_at, updated_at, search_key)
       VALUES (?1, 'Lahti', ?2, 'LUT', 'LTKY', 'full', ?3, ?4, ?5, 'board', 1, 1, 1, lower(?1))`,
    )
    .bind(name, `${name.toLowerCase().replace(/ /g, '.')}@example.com`, discordId, name.split(' ')[0], status)
    .run();
  return Number(result.meta.last_row_id);
}

describe('automatic ticks', () => {
  it('validates the kind', async () => {
    await expect(addTickKind(env.DB, { name: 'Bad', description: '', xp: '5', season_cap: '', auto_source: 'minecraft', auto_step: '0' }, 'axi', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(addTickKind(env.DB, { name: 'Bad', description: '', xp: '5', season_cap: '', auto_source: 'weather' }, 'axi', NOW)).rejects.toBeInstanceOf(RuleError);
    const ev = await addTickKind(env.DB, { name: 'Attended an event', description: '', xp: '50', season_cap: '', auto_source: 'events', claimable: 'on' }, 'axi', NOW);
    expect(ev).toMatchObject({ auto_source: 'events', auto_step: 1, claimable: false }); // the bot's ticks are not for claiming
  });

  it('pays play time, chat and events once each, through the caps, and tells the channel', async () => {
    const aino = await member('Aino Virtanen', AINO);
    await member('Bo Hidden', BO);
    await member('Cecilia Former', '100000000000000003', 'former');
    await env.DB.prepare('INSERT INTO members (discord_id, username, last_seen, leaderboard_hidden) VALUES (?1, ?2, 1, ?3)').bind(AINO, 'Aino', 0).run();
    await env.DB.prepare('INSERT INTO members (discord_id, username, last_seen, leaderboard_hidden) VALUES (?1, ?2, 1, ?3)').bind(BO, 'Bo', 1).run();
    // Aino: 150 minutes on Minecraft under her own name, 120 messages; Bo: 70 messages, in voice 30 min.
    await env.DB.prepare("INSERT INTO minecraft_names (discord_id, name, uuid, kind, added_at) VALUES (?1, 'AinoV', ?2, 'own', 1)").bind(AINO, UUID).run();
    for (const [day, minutes] of [['2026-09-02', 100], ['2026-09-05', 50], ['2026-06-01', 600]] as const) {
      await env.DB.prepare("INSERT INTO minecraft_playtime (uuid, server, day, minutes, updated_at) VALUES (?1, 'smp', ?2, ?3, 1)").bind(UUID, day, minutes).run();
    }
    await env.DB.prepare('INSERT INTO discord_activity (discord_id, day, messages, voice_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, 1)').bind(AINO, '2026-09-03', 120, 0).run();
    await env.DB.prepare('INSERT INTO discord_activity (discord_id, day, messages, voice_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, 1)').bind(BO, '2026-09-03', 70, 30).run();
    // Two past events this season, Aino at both, Bo at one; one still ahead.
    for (const [title, at] of [['Rocket League night', NOW - 86400], ['CS2 night', NOW - 3600], ['Later', NOW + 86400]] as const) {
      await env.DB.prepare("INSERT INTO events (title, starts_at, created_by, created_at, published_at) VALUES (?1, ?2, ?3, 1, 1)").bind(title, at, AINO).run();
    }
    for (const [event, id] of [[1, AINO], [2, AINO], [3, AINO], [1, BO]] as const) {
      await env.DB.prepare("INSERT INTO signups (event_id, discord_id, status, created_at) VALUES (?1, ?2, 'yes', 1)").bind(event, id).run();
    }
    expect((await memberTotals(env.DB, 'minecraft', NOW)).map((m) => [m.discord_id, m.total])).toEqual([[AINO, 150]]);
    expect((await memberTotals(env.DB, 'messages', NOW)).map((m) => [m.discord_id, m.total]).sort()).toEqual([[AINO, 120], [BO, 70]]);
    expect((await attendances(env.DB, NOW)).map((a) => [a.discord_id, a.event_id]).sort()).toEqual([[AINO, 1], [AINO, 2], [BO, 1]]);

    const mc = await addTickKind(env.DB, { name: 'Played Minecraft for an hour', description: '', xp: '20', season_cap: '1', period: 'season', auto_source: 'minecraft', auto_step: '60' }, 'axi', NOW);
    const chat = await addTickKind(env.DB, { name: 'Chatted', description: '', xp: '5', season_cap: '', auto_source: 'messages', auto_step: '50' }, 'axi', NOW);
    const [ev] = await listTickKinds(env.DB).then((k) => k.filter((x) => x.auto_source === 'events'));

    const posted: string[] = [];
    const dms: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.includes('/webhooks/')) { posted.push(body.content); return new Response(JSON.stringify({ id: '1' }), { status: 200 }); }
      if (url.endsWith('/users/@me/channels')) return new Response(JSON.stringify({ id: 'dm1' }), { status: 200 });
      if (url.includes('/channels/dm1/messages')) { dms.push(body.content); return new Response('{}', { status: 200 }); }
      return new Response('{}', { status: 204 });
    });
    try {
      const told = await announceAutoTicks(env.DB, { WELCOME_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x', DISCORD_BOT_TOKEN: 't' }, 'https://lahtiag.fi', NOW);
      expect(told).toBe(2);
      // Aino: 2 hours (one over the cap of 1, so 20 XP), 2 chat steps (10), 2 events (100) = 130 XP.
      expect(posted).toHaveLength(1); // Aino in the channel; Bo, hidden, by DM
      expect(posted[0]).toBe('✨ **Aino** got **130 XP**: Attended an event (Rocket League night) · Attended an event (CS2 night) · Played Minecraft for an hour, 1 h on Minecraft · Chatted, 100 messages.');
      // Bo: hidden, so a DM: 1 chat step (5) + 1 event (50).
      expect(dms).toHaveLength(1);
      expect(dms[0]).toContain('**Bo** got **55 XP**');
      expect(dms[0]).toContain('hidden from the leaderboard');
      // Nothing more to give on a rerun.
      expect(await giveAutoTicks(env.DB, NOW + 900)).toEqual([]);
      expect(await announceAutoTicks(env.DB, { WELCOME_WEBHOOK_URL: 'x' }, 'https://lahtiag.fi', NOW + 900)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const summary = await seasonSummary(env.DB, AINO, NOW + 1000);
    expect(summary.ticks.map((t) => t.kind).sort()).toEqual(['Attended an event', 'Attended an event', 'Chatted', 'Chatted', 'Played Minecraft for an hour', 'Played Minecraft for an hour'].sort());
    expect(summary.tick_xp).toBe(130);
    // More play time: the third hour is over the cap and given quietly.
    await env.DB.prepare("INSERT INTO minecraft_playtime (uuid, server, day, minutes, updated_at) VALUES (?1, 'smp', '2026-09-06', 40, 1)").bind(UUID).run();
    const more = await giveAutoTicks(env.DB, NOW + 2000);
    expect(more.map((t) => [t.kind.id, t.xp, t.total])).toEqual([[mc.id, 0, 180]]);
    expect(chat.id).toBeGreaterThan(0);
    expect(ev.xp).toBe(50);
  });

  it('writes the lines', () => {
    expect(countLabel('minecraft', 150)).toBe('2 h 30 min on Minecraft');
    expect(countLabel('voice', 30)).toBe('30 min in voice');
    expect(countLabel('messages', 50)).toBe('50 messages');
    const kind = { id: 1, name: 'Chatted', auto_source: 'messages' as const };
    expect(autoLine('Aino *x*', [{ register_id: 1, discord_id: 'a', kind: kind as never, xp: 5, total: 50, event: null }])).toBe('✨ **Aino x** got **5 XP**: Chatted, 50 messages.');
  });
});
