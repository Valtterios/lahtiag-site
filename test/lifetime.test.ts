import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { lifetimeTotals } from '../src/lib/season';

// The membership card carries the whole record, not one season, so these
// have to reach past 1 September in both directions — and still count only
// the play under the member's own name.

const AINO = '100000000000000001';
const BO = '100000000000000002';
const UUID_OWN = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const UUID_FRIEND = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';

describe('a member’s whole record', () => {
  it('is zero before anything is counted', async () => {
    expect(await lifetimeTotals(env.DB, AINO)).toEqual({ messages: 0, voice_minutes: 0, minecraft_minutes: 0 });
  });

  it('adds up every season, theirs only, and only their own Minecraft name', async () => {
    const activity = (id: string, day: string, messages: number, voice: number) =>
      env.DB
        .prepare('INSERT INTO discord_activity (discord_id, day, messages, voice_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, 1)')
        .bind(id, day, messages, voice)
        .run();
    await activity(AINO, '2024-10-02', 40, 12);
    await activity(AINO, '2026-09-01', 2, 5); // a later season
    await activity(BO, '2026-09-01', 900, 900); // somebody else

    const play = (uuid: string, server: string, day: string, minutes: number) =>
      env.DB
        .prepare('INSERT INTO minecraft_playtime (uuid, server, day, minutes, updated_at) VALUES (?1, ?2, ?3, ?4, 1)')
        .bind(uuid, server, day, minutes)
        .run();
    await play(UUID_OWN, 'smp', '2024-10-02', 90);
    await play(UUID_OWN, 'gtnh', '2026-09-02', 30);
    await play(UUID_FRIEND, 'smp', '2026-09-02', 500); // a friend on their membership
    await env.DB
      .prepare("INSERT INTO minecraft_names (discord_id, name, uuid, kind, added_at) VALUES (?1, 'AinoV', ?2, 'own', 1)")
      .bind(AINO, UUID_OWN)
      .run();
    await env.DB
      .prepare("INSERT INTO minecraft_names (discord_id, name, uuid, kind, added_at) VALUES (?1, 'Kaveri', ?2, 'friend', 1)")
      .bind(AINO, UUID_FRIEND)
      .run();

    expect(await lifetimeTotals(env.DB, AINO)).toEqual({ messages: 42, voice_minutes: 17, minecraft_minutes: 120 });
    expect(await lifetimeTotals(env.DB, BO)).toEqual({ messages: 900, voice_minutes: 900, minecraft_minutes: 0 });
  });
});
