import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { xpStandings, leaderboardText, XP_NOTE } from '../src/lib/xp';
import { addTickKind, giveTick, listTickKinds } from '../src/lib/ticks';

const NOW = Date.UTC(2026, 8, 7, 12) / 1000;
const LAST_SEASON = Date.UTC(2026, 4, 3, 12) / 1000;
const IDS = ['100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004'];

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

describe('the XP leaderboard', () => {
  it('is empty until the first tick', async () => {
    expect(await xpStandings(env.DB, NOW)).toEqual([]);
    const text = leaderboardText([], IDS[0], NOW);
    expect(text).toContain('🏆 **Season 2026–27 leaderboard**');
    expect(text).toContain('No XP yet this season.');
    expect(text).toContain('You: no XP yet.');
    expect(text).toContain(XP_NOTE);
  });

  it('ranks members by this season, caps applied, hidden ones kept off the list', async () => {
    const [aino, bo, cecilia, dan] = await Promise.all([
      member('Aino Virtanen', IDS[0]),
      member('Bo Berg', IDS[1]),
      member('Cecilia Hidden', IDS[2]),
      member('Dan Former', IDS[3]),
    ]);
    await member('Erik Unlinked', null);
    for (const [id, name, hidden] of [[IDS[0], 'Aino', 0], [IDS[2], 'Cecilia', 1]] as const) {
      await env.DB.prepare('INSERT INTO members (discord_id, username, last_seen, leaderboard_hidden) VALUES (?1, ?2, 1, ?3)').bind(id, name, hidden).run();
    }
    const [helped] = await listTickKinds(env.DB); // 100 XP, once a season
    const gear = await addTickKind(env.DB, { name: 'Brought gear', description: '', xp: '30', season_cap: '' }, 'axi', NOW);
    await giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: null }, 'axi', NOW);
    await giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: null }, 'axi', NOW + 1); // over the cap
    await giveTick(env.DB, { kindId: gear.id, registerId: aino, eventId: null }, 'axi', NOW + 2);
    await giveTick(env.DB, { kindId: helped.id, registerId: bo, eventId: null }, 'axi', NOW + 3);
    await giveTick(env.DB, { kindId: gear.id, registerId: bo, eventId: null }, 'axi', NOW + 4);
    await giveTick(env.DB, { kindId: helped.id, registerId: cecilia, eventId: null }, 'axi', NOW + 5);
    await giveTick(env.DB, { kindId: helped.id, registerId: dan, eventId: null }, 'axi', NOW + 6);
    await env.DB.prepare("UPDATE register SET status = 'former' WHERE id = ?1").bind(dan).run(); // a former member is not ranked
    await giveTick(env.DB, { kindId: gear.id, registerId: bo, eventId: null }, 'axi', LAST_SEASON); // last season: not counted

    const standings = await xpStandings(env.DB, NOW);
    expect(standings).toEqual([
      { discord_id: IDS[0], username: 'Aino', xp: 130, hidden: false, rank: 1 },
      { discord_id: IDS[1], username: null, xp: 130, hidden: false, rank: 1 },
      { discord_id: IDS[2], username: 'Cecilia', xp: 100, hidden: true, rank: 3 },
    ]);

    const asBo = leaderboardText(standings, IDS[1], NOW);
    expect(asBo).toContain('1. **Aino** · 130 XP');
    expect(asBo).toContain(`1. <@${IDS[1]}> · 130 XP`);
    expect(asBo).not.toContain('Cecilia');
    expect(asBo).not.toContain('You:');

    const asCecilia = leaderboardText(standings, IDS[2], NOW);
    expect(asCecilia).toContain('You: hidden from the list, as you chose on your membership page.');
    expect(asCecilia).not.toContain('100 XP');

    const asStranger = leaderboardText(standings, IDS[3], NOW);
    expect(asStranger).toContain('You: no XP yet.');

    // A short list shows the caller's own rank below it.
    const asAinoShort = leaderboardText(standings, IDS[1], NOW, 1);
    expect(asAinoShort).toContain('1. **Aino** · 130 XP');
    expect(asAinoShort).toContain('You: #1 with 130 XP.');
  });
});
