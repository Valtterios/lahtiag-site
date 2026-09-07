import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { availableSeasons, mondayOf, pickSeason, seasonTotals, seasonWeeks, serverStats, weeklyStats, weekLabel } from '../src/lib/season-stats';
import { seasonBounds, seasonName, seasonYears } from '../src/lib/activity';

const NOW = Date.UTC(2026, 8, 7, 12) / 1000; // Monday 7 September 2026
const AINO = '100000000000000001';
const BO = '100000000000000002';
const UUID_A = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const UUID_B = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';

describe('seasons', () => {
  it('bounds a season by 1 September and 31 August, or today', () => {
    expect(seasonBounds(2026, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-07' });
    expect(seasonBounds(2025, NOW)).toEqual({ from: '2025-09-01', to: '2026-08-31' });
    expect(seasonName(2026)).toBe('2026–27');
    expect(seasonYears(null, NOW)).toEqual([2026]);
    expect(seasonYears('2026-09-03', NOW)).toEqual([2026]);
    expect(seasonYears('2026-05-03', NOW)).toEqual([2026, 2025]);
    expect(seasonYears('2024-10-01', NOW)).toEqual([2026, 2025, 2024]);
    expect(pickSeason(null, [2026, 2025], NOW)).toBe(2026);
    expect(pickSeason('2025', [2026, 2025], NOW)).toBe(2025);
    expect(pickSeason('2024', [2026, 2025], NOW)).toBe(2026);
    expect(pickSeason('x', [2026, 2025], NOW)).toBe(2026);
  });

  it('lists the weeks by their Mondays', () => {
    expect(mondayOf('2026-09-07')).toBe('2026-09-07');
    expect(mondayOf('2026-09-06')).toBe('2026-08-31');
    expect(mondayOf('2026-09-01')).toBe('2026-08-31');
    expect(seasonWeeks(2026, NOW)).toEqual(['2026-08-31', '2026-09-07']);
    expect(seasonWeeks(2025, NOW).length).toBe(53);
    expect(seasonWeeks(2025, NOW)[0]).toBe('2025-09-01');
    expect(weekLabel('2026-09-07')).toBe('7 Sept');
  });
});

describe('the board stats', () => {
  it('offers only the current season when nothing is counted yet', async () => {
    expect(await availableSeasons(env.DB, NOW)).toEqual([2026]);
    expect(await weeklyStats(env.DB, 2026, NOW)).toEqual([
      { week: '2026-08-31', messages: 0, voice_minutes: 0, people: 0, minecraft_minutes: 0, players: 0 },
      { week: '2026-09-07', messages: 0, voice_minutes: 0, people: 0, minecraft_minutes: 0, players: 0 },
    ]);
  });

  it('adds a season up by week, channel and server, nobody named', async () => {
    await env.DB
      .prepare(
        `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, status, source, applied_at, consented_at, updated_at, search_key)
         VALUES ('Aino Virtanen', 'Lahti', 'aino@example.com', 'LUT', 'LTKY', 'full', ?1, 'member', 'board', 1, 1, 1, 'aino')`,
      )
      .bind(AINO)
      .run();
    const activity = (id: string, day: string, messages: number, voice: number) =>
      env.DB.prepare('INSERT INTO discord_activity (discord_id, day, messages, voice_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, 1)').bind(id, day, messages, voice).run();
    await activity(AINO, '2026-09-01', 10, 30);
    await activity(BO, '2026-09-02', 5, 0);
    await activity(AINO, '2026-09-07', 3, 0);
    await activity(AINO, '2026-05-03', 100, 100); // last season
    const play = (uuid: string, server: string, day: string, minutes: number) =>
      env.DB.prepare('INSERT INTO minecraft_playtime (uuid, server, day, minutes, updated_at) VALUES (?1, ?2, ?3, ?4, 1)').bind(uuid, server, day, minutes).run();
    await play(UUID_A, 'smp', '2026-09-03', 60);
    await play(UUID_B, 'smp', '2026-09-03', 15);
    await play(UUID_A, 'gtnh', '2026-09-07', 20);
    await env.DB.prepare("INSERT INTO minecraft_names (discord_id, name, uuid, kind, added_at) VALUES (?1, 'AinoV', ?2, 'own', 1)").bind(AINO, UUID_A).run();

    expect(await seasonTotals(env.DB, 2026, NOW)).toEqual({
      messages: 18,
      voice_minutes: 30,
      people: 2,
      members: 1,
      minecraft_minutes: 95,
      players: 2,
      linked_players: 1,
    });
    expect(await seasonTotals(env.DB, 2025, NOW)).toMatchObject({ messages: 100, voice_minutes: 100, people: 1, minecraft_minutes: 0, players: 0 });
    expect(await weeklyStats(env.DB, 2026, NOW)).toEqual([
      { week: '2026-08-31', messages: 15, voice_minutes: 30, people: 2, minecraft_minutes: 75, players: 2 },
      { week: '2026-09-07', messages: 3, voice_minutes: 0, people: 1, minecraft_minutes: 20, players: 1 },
    ]);
    expect(await serverStats(env.DB, 2026, NOW)).toEqual([
      { server: 'smp', label: 'SMP', minutes: 75, players: 2, linked: 1 },
      { server: 'gtnh', label: 'GT:NH modpack', minutes: 20, players: 1, linked: 1 },
    ]);
    expect(await availableSeasons(env.DB, NOW)).toEqual([2026, 2025]);
  });

});
