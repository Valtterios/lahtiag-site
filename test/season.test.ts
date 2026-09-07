import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { seasonEvents, seasonStartUnix, seasonSummary, minecraftLine, seasonLines } from '../src/lib/season';

const NOW = Date.UTC(2026, 8, 6, 12) / 1000;
const ID = '100000000000000001';

describe('the season so far', () => {
  it('starts on 1 September, Helsinki time', () => {
    expect(seasonStartUnix(NOW)).toBe(Date.UTC(2026, 7, 31, 21) / 1000);
    expect(seasonStartUnix(Date.UTC(2027, 3, 1) / 1000)).toBe(Date.UTC(2026, 7, 31, 21) / 1000);
  });

  it('counts the events attended since then', async () => {
    await env.DB.prepare("INSERT INTO members (discord_id, username, last_seen) VALUES (?1, 'Aino', 1)").bind(ID).run();
    const event = (title: string, startsAt: number) =>
      env.DB.prepare("INSERT INTO events (title, starts_at, created_by, created_at, published_at) VALUES (?1, ?2, ?3, 1, 1)").bind(title, startsAt, ID).run();
    await event('Spring cup', Date.UTC(2026, 3, 19) / 1000); // last season
    await event('Board games', Date.UTC(2026, 8, 3, 15) / 1000); // this season, over
    await event('Autumn LAN', Date.UTC(2026, 9, 3, 9) / 1000); // this season, not yet
    for (const id of [1, 2, 3]) await env.DB.prepare("INSERT INTO signups (event_id, discord_id, status, created_at) VALUES (?1, ?2, 'yes', 1)").bind(id, ID).run();
    expect(await seasonEvents(env.DB, ID, NOW)).toBe(1);
    const summary = await seasonSummary(env.DB, ID, NOW);
    expect(summary).toMatchObject({ label: '2026–27', events: 1, messages: 0, voice_minutes: 0, minecraft_name: null });
    expect(minecraftLine(summary, 'Fix it.')).toMatch(/No Minecraft name is linked to you.*Fix it\./);
    expect(seasonLines(summary, 'https://lahtiag.fi')).toContain('📅 Events attended: **1**');
  });

  it('names the play time or its absence', () => {
    const base = { label: '2026–27', events: 0, messages: 0, voice_minutes: 0, playtime: [{ server: 'smp', label: 'SMP', minutes: 0 }], ticks: [] };
    expect(minecraftLine({ ...base, minecraft_name: 'AinoV' }, '')).toBe('No play time yet under AinoV.');
    expect(minecraftLine({ ...base, minecraft_name: 'AinoV', playtime: [{ server: 'smp', label: 'SMP', minutes: 130 }, { server: 'gtnh', label: 'GT:NH modpack', minutes: 0 }] }, '')).toBe('SMP 2 h 10 min, as AinoV.');
  });
});
