import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { xpStandings, lifetimeXp, leaderboardEmbed, leaderboardTable, ownLine, shownName, XP_NOTE } from '../src/lib/xp';
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
    const embed = leaderboardEmbed([], IDS[0], NOW) as { title: string; description: string; footer: { text: string } };
    expect(embed.title).toBe('🏆 Season 2026–27 leaderboard');
    expect(embed.description).toContain('No XP yet this season.');
    expect(embed.description).toContain('You: no XP yet.');
    expect(embed.footer.text).toBe(XP_NOTE);
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
      { discord_id: IDS[0], username: 'Aino', avatar_hash: null, handle: null, xp: 130, hidden: false, rank: 1 },
      { discord_id: IDS[1], username: null, avatar_hash: null, handle: null, xp: 130, hidden: false, rank: 1 },
      { discord_id: IDS[2], username: 'Cecilia', avatar_hash: null, handle: null, xp: 100, hidden: true, rank: 3 },
    ]);
    // The name in the table: the cached Discord name, else the register's handle, else a stub.
    expect(shownName(standings[0])).toBe('Aino');
    expect(shownName(standings[1])).toBe('member …0002');
    expect(shownName({ ...standings[1], handle: 'bo_b' })).toBe('bo_b');

    const table = leaderboardTable(standings);
    expect(table).toBe('```\n 1  Aino              130 XP\n 1  member …0002      130 XP\n```');
    expect(table).not.toContain('Cecilia');
    expect(ownLine(standings, IDS[1])).toBeNull();
    expect(ownLine(standings, IDS[2])).toBe('You: hidden from the list, as you chose on your membership page. `/season` shows your XP.');
    expect(ownLine(standings, IDS[3])).toBe('You: no XP yet. `/season` shows what counts.');
    expect(ownLine(standings, null)).toBeNull();
    // A short list shows the caller's own rank below it.
    expect(ownLine(standings, IDS[1], 1)).toBe('You: #1 with 130 XP.');
    const embed = leaderboardEmbed(standings, IDS[1], NOW, 1) as { description: string; color: number };
    expect(embed.color).toBe(0x2b5cff);
    expect(embed.description).toBe('```\n 1  Aino              130 XP\n```\nYou: #1 with 130 XP.');
  });

  it('adds every season together for the card, each capped on its own', async () => {
    // Aino: this season 100 (helped, capped once) + 30 (gear) = 130; Bo has
    // 130 this season and 30 from last season, capped in its own season.
    expect(await lifetimeXp(env.DB, IDS[0])).toBe(130);
    expect(await lifetimeXp(env.DB, IDS[1])).toBe(160);
    expect(await lifetimeXp(env.DB, '100000000000000009')).toBe(0);
  });
});
