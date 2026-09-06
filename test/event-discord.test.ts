import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setSignup, removeSignup, deleteEvent, addManualParticipant, purgeMember, getEvent } from '../src/lib/db';
import {
  channelSlug,
  roleName,
  participantIds,
  planEventRole,
  syncEventRole,
  syncMemberEventRoles,
  listGrants,
  countGrants,
  tearDownEventDiscord,
  welcomeMessage,
  isDiscordSnowflake,
  scheduledEventFields,
  scheduledEventUrl,
  syncScheduledEvent,
  DEFAULT_EVENT_HOURS,
  type SetRole,
} from '../src/lib/event-discord';
import type { RoleResult } from '../src/lib/discord';

// The per-event Discord role: naming, the pure plan, and the sync against
// D1 with Discord stood in for by a recording stub.

const NOW = 1_760_000_000;
const db = () => env.DB;
const cfg = { DISCORD_BOT_TOKEN: 'tok' };

async function wipe(): Promise<void> {
  for (const table of ['event_role_grants', 'signups', 'event_teams', 'events', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function seedMember(id: string): Promise<void> {
  await upsertMember(db(), { discord_id: id, username: `user-${id}`, avatar_hash: null }, NOW);
}

async function seedEvent(): Promise<number> {
  await seedMember('100');
  return createEvent(db(), { title: 'Autumn LAN', description: null, starts_at: NOW + 86400, capacity: null, created_by: '100' }, NOW);
}

// A stand-in for Discord: records every call, answers per user.
function stub(answers: Record<string, RoleResult> = {}) {
  const calls: string[] = [];
  const setRole: SetRole = async (userId, on) => {
    calls.push(`${userId}:${on ? '+' : '-'}`);
    return answers[userId] ?? 'ok';
  };
  return { calls, setRole };
}

describe('names', () => {
  it('slugs titles the way Discord channel names want', () => {
    expect(channelSlug('Autumn LAN 2026!')).toBe('autumn-lan-2026');
    expect(channelSlug('Pöytäpelit & Kahvi')).toBe('poytapelit-kahvi');
    expect(channelSlug('   ')).toBe('event');
    expect(channelSlug('', 'event-7')).toBe('event-7');
    expect(channelSlug('x'.repeat(200)).length).toBeLessThanOrEqual(90);
  });

  it('keeps the title as the role name, capped', () => {
    expect(roleName('  Autumn LAN  ')).toBe('Autumn LAN');
    expect(roleName('')).toBe('Event');
    expect(roleName('y'.repeat(150)).length).toBe(100);
  });

  it('tells real accounts from walk-ins', () => {
    expect(isDiscordSnowflake('123456789012345678')).toBe(true);
    expect(isDiscordSnowflake('manual-abcdef')).toBe(false);
    expect(participantIds([{ discord_id: '111111' }, { discord_id: 'manual-1' }, { discord_id: '111111' }, { discord_id: '222222' }])).toEqual(['111111', '222222']);
  });

  it('mentions the role without pinging anyone, and links the event', () => {
    const text = welcomeMessage({ title: ' LAN ', starts_at: NOW, ends_at: null }, 'R1', 'https://lahtiag.fi/events/3');
    expect(text).toContain('**LAN**');
    expect(text).toContain('<@&R1>');
    expect(text).toContain('https://lahtiag.fi/events/3');
  });
});

describe('planEventRole', () => {
  it('adds the missing, removes the extra, additions first', () => {
    const plan = planEventRole(['a', 'b', 'c'], ['b', 'z']);
    expect(plan).toEqual([
      { discordId: 'a', on: true },
      { discordId: 'c', on: true },
      { discordId: 'z', on: false },
    ]);
    expect(planEventRole(['a'], ['a'])).toEqual([]);
  });
});

describe('syncEventRole', () => {
  beforeEach(wipe);

  it('does nothing for an event without a role, or without the bot', async () => {
    const id = await seedEvent();
    const { calls, setRole } = stub();
    expect(await syncEventRole(db(), cfg, id, NOW, 40, setRole)).toBeNull();
    await db().prepare("UPDATE events SET discord_role_id = 'R' WHERE id = ?1").bind(id).run();
    expect(await syncEventRole(db(), {}, id, NOW, 40, setRole)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('gives the role to the roster, remembers it, and takes it back when someone leaves', async () => {
    const id = await seedEvent();
    await db().prepare("UPDATE events SET discord_role_id = 'R' WHERE id = ?1").bind(id).run();
    await seedMember('111111');
    await seedMember('222222');
    await setSignup(db(), id, '111111', 'yes', NOW);
    await setSignup(db(), id, '222222', 'maybe', NOW);
    await addManualParticipant(db(), id, 'Walk-in', 'yes', null, NOW);

    const first = stub();
    expect(await syncEventRole(db(), cfg, id, NOW, 40, first.setRole)).toEqual({ added: 2, removed: 0, notInServer: 0, forbidden: 0, failed: 0, remaining: 0 });
    expect(first.calls.sort()).toEqual(['111111:+', '222222:+']);
    expect((await listGrants(db(), id)).sort()).toEqual(['111111', '222222']);

    // Nothing to do the second time.
    const second = stub();
    expect(await syncEventRole(db(), cfg, id, NOW, 40, second.setRole)).toMatchObject({ added: 0, removed: 0 });
    expect(second.calls).toEqual([]);

    await removeSignup(db(), id, '111111');
    const third = stub();
    expect(await syncEventRole(db(), cfg, id, NOW, 40, third.setRole)).toMatchObject({ added: 0, removed: 1 });
    expect(third.calls).toEqual(['111111:-']);
    expect(await listGrants(db(), id)).toEqual(['222222']);
    expect(await countGrants(db(), id)).toBe(1);
  });

  it('leaves someone not in the server ungranted so a later sync retries, and counts refusals', async () => {
    const id = await seedEvent();
    await db().prepare("UPDATE events SET discord_role_id = 'R' WHERE id = ?1").bind(id).run();
    for (const who of ['111111', '222222', '333333']) {
      await seedMember(who);
      await setSignup(db(), id, who, 'yes', NOW);
    }
    const { setRole } = stub({ '222222': 'not_in_guild', '333333': 'forbidden' });
    expect(await syncEventRole(db(), cfg, id, NOW, 40, setRole)).toEqual({ added: 1, removed: 0, notInServer: 1, forbidden: 1, failed: 0, remaining: 0 });
    expect(await listGrants(db(), id)).toEqual(['111111']);
    // They joined the server: the next sync gets them.
    const later = stub();
    expect(await syncEventRole(db(), cfg, id, NOW, 40, later.setRole)).toMatchObject({ added: 2 });
    expect(later.calls.sort()).toEqual(['222222:+', '333333:+']);
  });

  it('caps one call and reports what is left', async () => {
    const id = await seedEvent();
    await db().prepare("UPDATE events SET discord_role_id = 'R' WHERE id = ?1").bind(id).run();
    for (const who of ['111111', '222222', '333333']) {
      await seedMember(who);
      await setSignup(db(), id, who, 'yes', NOW);
    }
    const { calls, setRole } = stub();
    expect(await syncEventRole(db(), cfg, id, NOW, 2, setRole)).toMatchObject({ added: 2, remaining: 1 });
    expect(calls.length).toBe(2);
  });

  it('strips an erased member from every event role they held', async () => {
    const a = await seedEvent();
    const b = await createEvent(db(), { title: 'Other', description: null, starts_at: NOW + 172800, capacity: null, created_by: '100' }, NOW);
    for (const id of [a, b]) await db().prepare("UPDATE events SET discord_role_id = 'R' WHERE id = ?1").bind(id).run();
    await seedMember('111111');
    await setSignup(db(), a, '111111', 'yes', NOW);
    await setSignup(db(), b, '111111', 'yes', NOW);
    const grant = stub();
    await syncEventRole(db(), cfg, a, NOW, 40, grant.setRole);
    await syncEventRole(db(), cfg, b, NOW, 40, grant.setRole);
    await purgeMember(db(), '111111');
    const strip = stub();
    await syncMemberEventRoles(db(), cfg, '111111', NOW, strip.setRole);
    expect(strip.calls).toEqual(['111111:-', '111111:-']);
    expect(await listGrants(db(), a)).toEqual([]);
    expect(await listGrants(db(), b)).toEqual([]);
  });

  it('forgets the grants when the event is deleted, or the pair torn down without a bot', async () => {
    const id = await seedEvent();
    await db().prepare("UPDATE events SET discord_role_id = 'R', discord_channel_id = 'C' WHERE id = ?1").bind(id).run();
    await seedMember('111111');
    await setSignup(db(), id, '111111', 'yes', NOW);
    await syncEventRole(db(), cfg, id, NOW, 40, stub().setRole);
    expect(await countGrants(db(), id)).toBe(1);
    // No token: Discord is untouched, the site still forgets both.
    expect(await tearDownEventDiscord(db(), {}, id)).toBe('partial');
    expect(await countGrants(db(), id)).toBe(0);
    expect((await getEvent(db(), id))?.discord_role_id).toBeNull();
    expect(await tearDownEventDiscord(db(), {}, id)).toBe('nothing');

    await db().prepare("UPDATE events SET discord_role_id = 'R' WHERE id = ?1").bind(id).run();
    await syncEventRole(db(), cfg, id, NOW, 40, stub().setRole);
    expect(await countGrants(db(), id)).toBe(1);
    await deleteEvent(db(), id);
    expect(await countGrants(db(), id)).toBe(0);
  });
});

describe("Discord's scheduled event", () => {
  beforeEach(wipe);

  it('takes the first paragraph, the organizers and the link, and falls back for the end and the place', () => {
    const fields = scheduledEventFields(
      { id: 5, title: ' LAN ', description: 'First paragraph.\n\nSecond one.', starts_at: NOW, ends_at: null, location: null, organizers: 'LahtiAG, Kapital' },
      'https://lahtiag.fi',
    );
    expect(fields.name).toBe('LAN');
    expect(fields.description).toBe('First paragraph.\n\nOrganized by LahtiAG, Kapital\n\nSign up: https://lahtiag.fi/events/5');
    expect(fields.startIso).toBe(new Date(NOW * 1000).toISOString());
    expect(fields.endIso).toBe(new Date((NOW + DEFAULT_EVENT_HOURS * 3600) * 1000).toISOString());
    expect(fields.location).toBe('https://lahtiag.fi/events/5');

    const placed = scheduledEventFields(
      { id: 5, title: 'LAN', description: 'x'.repeat(2000), starts_at: NOW, ends_at: NOW + 60, location: ' Mukkulankatu 19 ', organizers: null },
      'https://lahtiag.fi',
    );
    expect(placed.location).toBe('Mukkulankatu 19');
    expect(placed.endIso).toBe(new Date((NOW + 60) * 1000).toISOString());
    expect(placed.description.length).toBeLessThanOrEqual(1000);
    expect(placed.description.endsWith('Sign up: https://lahtiag.fi/events/5')).toBe(true);
    expect(scheduledEventUrl('E1')).toMatch(/^https:\/\/discord\.com\/events\/\d+\/E1$/);
  });

  it('touches Discord only for published, upcoming events', async () => {
    const id = await seedEvent();
    expect(await syncScheduledEvent(db(), {}, id, 'https://lahtiag.fi', NOW)).toBe('unconfigured');
    // A draft without a Discord event: nothing to make or remove.
    await db().prepare('UPDATE events SET published_at = NULL WHERE id = ?1').bind(id).run();
    expect(await syncScheduledEvent(db(), cfg, id, 'https://lahtiag.fi', NOW)).toBe('skipped');
    // Published but already started: left alone.
    await db().prepare('UPDATE events SET published_at = ?2 WHERE id = ?1').bind(id, NOW).run();
    expect(await syncScheduledEvent(db(), cfg, id, 'https://lahtiag.fi', NOW + 86400 * 2)).toBe('skipped');
    expect(await syncScheduledEvent(db(), cfg, 999, 'https://lahtiag.fi', NOW)).toBe('error');
  });
});
