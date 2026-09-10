import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { addPassLevel, savePassLevel, removePassLevel, listPassLevels, passProgress, passLines, bar, recordReached, memberReached, reachedLine, reachedDm, announceReached, levelTitle, rewardText, type PassLevel } from '../src/lib/pass';
import { giveTick, listTickKinds, addTickKind, removeTick } from '../src/lib/ticks';
import { seasonSummary, seasonLines } from '../src/lib/season';
import { RuleError } from '../src/lib/db';

// The season pass: the levels the board sets, where XP puts a member on
// them, and the once-only ledger behind the announcements.

const NOW = Date.UTC(2026, 8, 7, 12) / 1000; // 7 September 2026: the 2026–27 season
const YEAR = 2026;
const IDS = ['100000000000000001', '100000000000000002', '100000000000000003'];

async function member(name: string, discordId: string | null, status = 'member'): Promise<number> {
  const result = await env.DB
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, status, source, applied_at, consented_at, updated_at, search_key)
       VALUES (?1, 'Lahti', ?2, 'LUT', 'LTKY', 'full', ?3, ?4, 'board', 1, 1, 1, lower(?1))`,
    )
    .bind(name, `${name.toLowerCase().replace(/ /g, '.')}@example.com`, discordId, status)
    .run();
  return Number(result.meta.last_row_id);
}

const level = (over: Partial<PassLevel>): PassLevel => ({ id: 0, season_year: YEAR, level: 1, xp: 100, name: 'Regular', reward: 'Patch', sponsor: null, role_id: null, reached: 0, ...over });

describe('the levels', () => {
  it('are numbered by XP however they are added, and refuse a duplicate line', async () => {
    const high = await addPassLevel(env.DB, YEAR, { xp: '300', name: 'Veteran', reward: 'Hoodie', sponsor: 'SteelSeries' }, 'axi', NOW);
    const low = await addPassLevel(env.DB, YEAR, { xp: '100', name: 'Regular', reward: 'Overall patch' }, 'axi', NOW);
    expect((await listPassLevels(env.DB, YEAR)).map((l) => [l.level, l.xp, l.name])).toEqual([[1, 100, 'Regular'], [2, 300, 'Veteran']]);
    await expect(addPassLevel(env.DB, YEAR, { xp: '300', name: 'Again', reward: 'x' }, 'axi', NOW)).rejects.toThrow(RuleError);
    // Moving a line renumbers.
    await savePassLevel(env.DB, low.id, { xp: '400', name: 'Regular', reward: 'Overall patch' }, NOW);
    expect((await listPassLevels(env.DB, YEAR)).map((l) => [l.level, l.id])).toEqual([[1, high.id], [2, low.id]]);
    // Bad input, in the same words the form gets.
    for (const bad of [{ xp: '0', name: 'x', reward: 'y' }, { xp: '10', name: 'A', reward: 'Patch' }, { xp: '10', name: 'Ok', reward: '' }, { xp: '10', name: 'Ok', reward: 'Patch', role_id: 'abc' }]) {
      await expect(addPassLevel(env.DB, YEAR, bad, 'axi', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    }
    // Another season's levels are a separate list.
    expect(await listPassLevels(env.DB, YEAR + 1)).toEqual([]);
    expect(await removePassLevel(env.DB, high.id)).toBe(true);
    expect((await listPassLevels(env.DB, YEAR)).map((l) => l.level)).toEqual([1]);
  });
});

describe('passProgress', () => {
  const levels = [level({ id: 1, level: 1, xp: 100 }), level({ id: 2, level: 2, xp: 250, name: 'Veteran', reward: 'Hoodie', sponsor: 'SteelSeries' }), level({ id: 3, level: 3, xp: 500, name: 'Legend', reward: 'A named prize' })];

  it('reads the track against an XP total', () => {
    expect(passProgress(0, levels)).toMatchObject({ current: null, next: levels[0], to_next: 100, fraction: 0 });
    expect(passProgress(175, levels)).toMatchObject({ current: levels[0], next: levels[1], to_next: 75, fraction: 0.5 });
    expect(passProgress(250, levels)).toMatchObject({ current: levels[1], next: levels[2], to_next: 250, fraction: 0 });
    expect(passProgress(900, levels)).toMatchObject({ current: levels[2], next: null, to_next: 0, fraction: 1 });
    expect(passProgress(40, [])).toMatchObject({ current: null, next: null, fraction: 1 });
  });

  it('writes the /season lines', () => {
    expect(passLines(passProgress(40, []), 'https://lahtiag.fi')[0]).toContain('has not set this season');
    const lines = passLines(passProgress(175, levels), 'https://lahtiag.fi');
    expect(lines[0]).toBe('🎫 Season pass: **175 XP** · **Level 1 · Regular**');
    expect(lines[1]).toBe('▰▰▰▰▰▱▱▱▱▱ **75 XP** to Level 2 · Veteran: Hoodie (from SteelSeries)');
    expect(lines[2]).toContain('/membership#pass');
    expect(passLines(passProgress(900, levels), 'x')[1]).toContain('Every level of the season reached');
    expect(bar(0)).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(levelTitle(levels[2])).toBe('Level 3 · Legend');
    expect(rewardText(levels[1])).toBe('Hoodie (from SteelSeries)');
  });

  it('writes the announcement and the DM', () => {
    expect(reachedLine('Aino', [levels[0]], YEAR)).toBe('🎫 **Aino** reached **Level 1 · Regular** on the 2026–27 season pass! Reward: Patch.');
    const two = reachedLine('Bo *bold*', [levels[1], levels[0]], YEAR);
    expect(two).toContain('**Bo bold** reached **Level 2 · Veteran**');
    expect(two).toContain('• Level 1 · Regular: Patch\n• Level 2 · Veteran: Hoodie from SteelSeries'); // brackets are stripped with the rest of the markdown
    expect(reachedDm([levels[0]], YEAR, 'https://lahtiag.fi')).toContain('hidden from the leaderboard');
  });
});

describe('the ledger', () => {
  it('records a crossing once, keeps it when the XP drops, and tells each member once', async () => {
    const [aino, bo] = await Promise.all([member('Aino Virtanen', IDS[0]), member('Bo Hidden', IDS[1])]);
    await member('Cecilia Unlinked', null);
    await env.DB.prepare('INSERT INTO members (discord_id, username, last_seen, leaderboard_hidden) VALUES (?1, ?2, 1, ?3)').bind(IDS[0], 'Aino', 0).run();
    await env.DB.prepare('INSERT INTO members (discord_id, username, last_seen, leaderboard_hidden) VALUES (?1, ?2, 1, ?3)').bind(IDS[1], 'Bo', 1).run();
    const one = await addPassLevel(env.DB, YEAR, { xp: '100', name: 'Regular', reward: 'Patch' }, 'axi', NOW);
    const two = await addPassLevel(env.DB, YEAR, { xp: '130', name: 'Veteran', reward: 'Hoodie' }, 'axi', NOW);
    const [helped] = await listTickKinds(env.DB); // 100 XP
    const gear = await addTickKind(env.DB, { name: 'Brought gear', description: '', xp: '30', season_cap: '' }, 'axi', NOW);

    // Nobody has anything: nothing recorded.
    expect(await recordReached(env.DB, NOW)).toEqual([]);

    await giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: null }, 'axi', NOW);
    const tick = await giveTick(env.DB, { kindId: gear.id, registerId: aino, eventId: null }, 'axi', NOW + 1);
    await giveTick(env.DB, { kindId: helped.id, registerId: bo, eventId: null }, 'axi', NOW + 2);

    const posted: string[] = [];
    const dms: string[] = [];
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.includes('/webhooks/')) { posted.push(body.content); return new Response(JSON.stringify({ id: '1' }), { status: 200 }); }
      if (url.endsWith('/users/@me/channels')) return new Response(JSON.stringify({ id: 'dm1' }), { status: 200 });
      if (url.includes('/channels/dm1/messages')) { dms.push(body.content); return new Response('{}', { status: 200 }); }
      return new Response('{}', { status: 204 });
    };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    try {
      const told = await announceReached(env.DB, { WELCOME_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x', DISCORD_BOT_TOKEN: 't' }, 'https://lahtiag.fi', NOW + 10);
      expect(told).toBe(2);
      expect(posted).toEqual([expect.stringContaining('**Aino** reached **Level 2 · Veteran**')]);
      expect(posted[0]).toContain('• Level 1 · Regular: Patch');
      expect(dms).toEqual([expect.stringContaining('Level 1 · Regular: Patch')]);
      // A second run says nothing.
      expect(await announceReached(env.DB, { WELCOME_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x', DISCORD_BOT_TOKEN: 't' }, 'https://lahtiag.fi', NOW + 20)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect((await memberReached(env.DB, IDS[0], YEAR)).sort()).toEqual([one.id, two.id].sort());
    expect(await memberReached(env.DB, IDS[1], YEAR)).toEqual([one.id]);
    const levels = await listPassLevels(env.DB, YEAR);
    expect(levels.map((l) => l.reached)).toEqual([2, 1, 0]); // the 400 XP level from the first test stays
    // A reached level cannot be removed.
    await expect(removePassLevel(env.DB, two.id)).rejects.toMatchObject({ code: 'reached' });

    // The XP drops back under the line: the ledger keeps the level, and the
    // page shows it as held.
    await removeTick(env.DB, tick.id);
    const summary = await seasonSummary(env.DB, IDS[0], NOW + 30);
    expect(summary.tick_xp).toBe(100);
    expect(summary.pass.current?.id).toBe(one.id);
    expect(summary.held).toContain(two.id);
    expect(seasonLines(summary, 'https://lahtiag.fi')).toContain('🎫 Season pass: **100 XP** · **Level 1 · Regular**');
    expect(await recordReached(env.DB, NOW + 40)).toEqual([]);
  });
});
