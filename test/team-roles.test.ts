import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent } from '../src/lib/db';
import {
  syncTeamDiscord,
  renameTeamDiscord,
  listTeamRoles,
  listTeamGrants,
  teamMemberIds,
  archiveEventDiscord,
  tearDownEventDiscord,
  stripTeamRoles,
  listEventChannels,
} from '../src/lib/event-discord';
import { postEventLine } from '../src/lib/event-channel';
import { DISCORD_GUILD_ID as GUILD } from '../src/lib/config';

// A mentionable Discord role per tournament team, so a team can be
// @-pinged, with its voice channel locked to that role. Discord is stood
// in for by a fetch stub that records every call.

const NOW = 1_760_000_000;
const db = () => env.DB;
const cfg = { DISCORD_BOT_TOKEN: 'tok', ADMIN_ROLE_ID: 'BOARD' };

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];

function discordStub(fail: (method: string, path: string) => number | null = () => null) {
  let roles = 0;
  let channels = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v10', '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const status = fail(method, path);
    if (status) return new Response('nope', { status });
    if (path === '/users/@me') return Response.json({ id: 'BOT' });
    if (method === 'POST' && path.endsWith('/roles')) return Response.json({ id: `ROLE${++roles}` });
    if (method === 'POST' && path.endsWith('/channels')) return Response.json({ id: `CH${++channels}` });
    return new Response(null, { status: 204 });
  });
}

async function seedBigEvent(): Promise<number> {
  await upsertMember(db(), { discord_id: '100', username: 'board', avatar_hash: null }, NOW);
  const id = await createEvent(db(), { title: 'Autumn LAN', description: null, starts_at: NOW + 86400, capacity: null, created_by: '100' }, NOW);
  await db()
    .prepare("UPDATE events SET team_size = 2, discord_role_id = 'EVENT', discord_channel_id = 'C', discord_category_id = 'K' WHERE id = ?1")
    .bind(id)
    .run();
  return id;
}

// Straight into D1: the rules around forming a team are event-teams'
// business, not this module's.
async function seedTeam(eventId: number, teamId: number, name: string, members: string[]): Promise<void> {
  await db()
    .prepare('INSERT INTO event_teams (id, event_id, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(teamId, eventId, name, '100', NOW + teamId)
    .run();
  for (const discordId of members) {
    await upsertMember(db(), { discord_id: discordId, username: `user-${discordId}`, avatar_hash: null }, NOW);
    await db()
      .prepare('INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(eventId, discordId, 'yes', NOW, teamId)
      .run();
  }
}

function memberCalls(): string[] {
  return calls.filter((c) => c.path.includes('/members/')).map((c) => `${c.method} ${c.path.split('/members/')[1]}`);
}

beforeEach(async () => {
  calls = [];
  for (const table of ['event_team_role_grants', 'event_team_roles', 'event_role_grants', 'event_discord_channels', 'signups', 'event_teams', 'events', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => vi.restoreAllMocks());

describe('teamMemberIds', () => {
  it('takes the team\'s own signups, walk-ins left out', () => {
    const signups = [
      { discord_id: '111111', event_team_id: 1 },
      { discord_id: '222222', event_team_id: 2 },
      { discord_id: 'manual-x', event_team_id: 1 },
      { discord_id: '333333', event_team_id: null },
    ];
    expect(teamMemberIds(signups, 1)).toEqual(['111111']);
    expect(teamMemberIds(signups, 2)).toEqual(['222222']);
  });
});

describe('syncTeamDiscord', () => {
  it('gives every team a role, locks its voice channel to it, and hands it to the line-up', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Team Kapital', ['111111', '222222']);
    await seedTeam(id, 2, 'Brigade', ['333333']);
    discordStub();

    expect(await syncTeamDiscord(db(), cfg, id, NOW)).toEqual({ ok: true, created: 2, removed: 0, teams: 2, roles: 2 });

    const made = calls.filter((c) => c.method === 'POST' && c.path === `/guilds/${GUILD}/roles`);
    expect(made.map((c) => c.body?.name)).toEqual(['Team Kapital', 'Brigade']);
    expect(made.every((c) => c.body?.mentionable === true)).toBe(true);

    // The role id is remembered, so the next sync makes nothing twice.
    const roles = await listTeamRoles(db(), id);
    expect(roles.map((r) => [r.event_team_id, r.role_id])).toEqual([
      [1, 'ROLE1'],
      [2, 'ROLE2'],
    ]);

    // Each voice channel admits its own team's role, not the event's.
    const channels = calls.filter((c) => c.method === 'POST' && c.path === `/guilds/${GUILD}/channels`);
    expect(channels.map((c) => c.body?.name)).toEqual(['Team Kapital', 'Brigade']);
    for (const [i, channel] of channels.entries()) {
      const overwrites = channel.body?.permission_overwrites as { id: string }[];
      expect(overwrites.map((o) => o.id)).toContain(`ROLE${i + 1}`);
      expect(overwrites.map((o) => o.id)).not.toContain('EVENT');
    }

    expect(memberCalls()).toEqual(['PUT 111111/roles/ROLE1', 'PUT 222222/roles/ROLE1', 'PUT 333333/roles/ROLE2']);
    expect(await listTeamGrants(db(), 1)).toEqual(['111111', '222222']);
    expect(await listTeamGrants(db(), 2)).toEqual(['333333']);

    // Nothing left to do: no second role, no second channel, no re-grant.
    calls = [];
    expect(await syncTeamDiscord(db(), cfg, id, NOW)).toEqual({ ok: true, created: 0, removed: 0, teams: 2, roles: 0 });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(memberCalls()).toEqual([]);
  });

  it('follows someone switching team, and takes the role back when they leave', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Kapital', ['111111']);
    await seedTeam(id, 2, 'Brigade', []);
    discordStub();
    await syncTeamDiscord(db(), cfg, id, NOW);

    calls = [];
    await db().prepare('UPDATE signups SET event_team_id = 2 WHERE discord_id = ?1').bind('111111').run();
    await syncTeamDiscord(db(), cfg, id, NOW);
    expect(memberCalls()).toEqual(['DELETE 111111/roles/ROLE1', 'PUT 111111/roles/ROLE2']);
    expect(await listTeamGrants(db(), 1)).toEqual([]);
    expect(await listTeamGrants(db(), 2)).toEqual(['111111']);

    calls = [];
    await db().prepare('DELETE FROM signups WHERE discord_id = ?1').bind('111111').run();
    await syncTeamDiscord(db(), cfg, id, NOW);
    expect(memberCalls()).toEqual(['DELETE 111111/roles/ROLE2']);
    expect(await listTeamGrants(db(), 2)).toEqual([]);
  });

  it('deletes the role and the channel of a disbanded team', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Kapital', ['111111']);
    discordStub();
    await syncTeamDiscord(db(), cfg, id, NOW);

    calls = [];
    await db().prepare('DELETE FROM signups WHERE event_team_id = 1').run();
    await db().prepare('DELETE FROM event_teams WHERE id = 1').run();
    expect(await syncTeamDiscord(db(), cfg, id, NOW)).toEqual({ ok: true, created: 0, removed: 1, teams: 0, roles: 0 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(`DELETE /guilds/${GUILD}/roles/ROLE1`);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /channels/CH1');
    expect(await listTeamRoles(db(), id)).toEqual([]);
    expect(await listTeamGrants(db(), 1)).toEqual([]);
    expect(await listEventChannels(db(), id)).toEqual([]);
  });

  it('locks a channel that predates its role when the role arrives', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Kapital', []);
    // A channel from before roles existed, admitting the event's role.
    await db()
      .prepare("INSERT INTO event_discord_channels (event_id, channel_id, kind, event_team_id, created_at) VALUES (?1, 'OLD', 'team', 1, ?2)")
      .bind(id, NOW)
      .run();
    discordStub();
    await syncTeamDiscord(db(), cfg, id, NOW);

    const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/channels/OLD');
    expect((patch?.body?.permission_overwrites as { id: string }[]).map((o) => o.id)).toContain('ROLE1');
  });

  it('leaves small events alone: no category, no roles', async () => {
    const id = await seedBigEvent();
    await db().prepare('UPDATE events SET discord_category_id = NULL WHERE id = ?1').bind(id).run();
    await seedTeam(id, 1, 'Kapital', ['111111']);
    const spy = discordStub();
    expect(await syncTeamDiscord(db(), cfg, id, NOW)).toEqual({ ok: false, reason: 'needs_category' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps what it managed to make when Discord refuses partway', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Kapital', []);
    await seedTeam(id, 2, 'Brigade', []);
    discordStub((method, path) => (method === 'POST' && path.endsWith('/roles') && calls.filter((c) => c.path.endsWith('/roles') && c.method === 'POST').length > 1 ? 403 : null));
    const result = await syncTeamDiscord(db(), cfg, id, NOW);
    expect(result).toMatchObject({ ok: true, roles: 1 });
    expect((await listTeamRoles(db(), id)).map((r) => r.event_team_id)).toEqual([1]);
  });
});

describe('renameTeamDiscord', () => {
  it('renames the channel and the role', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Kapital', []);
    discordStub();
    await syncTeamDiscord(db(), cfg, id, NOW);

    calls = [];
    await renameTeamDiscord(db(), cfg, id, 1, '  Kapital Reborn  ');
    expect(calls.map((c) => `${c.method} ${c.path} ${c.body?.name}`)).toEqual([
      'PATCH /channels/CH1 Kapital Reborn',
      `PATCH /guilds/${GUILD}/roles/ROLE1 Kapital Reborn`,
    ]);
  });
});

describe('the pings a team role is for', () => {
  it('lets Discord notify the roles a line calls, alongside the event role', async () => {
    const id = await seedBigEvent();
    discordStub();
    // A match call: the two teams are notified, the event is not woken.
    expect(await postEventLine(db(), cfg, id, 'Next up: <@&ROLE1> vs <@&ROLE3>.', false, undefined, ['ROLE1', 'ROLE3'])).toBe(true);
    const call = calls.find((c) => c.method === 'POST' && c.path.startsWith('/channels/'));
    expect(call?.body?.allowed_mentions).toEqual({ parse: [], roles: ['ROLE1', 'ROLE3'] });
    expect(String(call?.body?.content)).not.toContain('<@&EVENT>');

    // The draw wakes the whole event and calls its teams in one message.
    calls = [];
    await postEventLine(db(), cfg, id, 'The bracket is out.', true, undefined, ['ROLE1']);
    const drawn = calls.find((c) => c.method === 'POST' && c.path.startsWith('/channels/'));
    expect(drawn?.body?.allowed_mentions).toEqual({ parse: [], roles: ['EVENT', 'ROLE1'] });
    expect(String(drawn?.body?.content)).toContain('<@&EVENT>');

    // Nothing to call: the line mentions nobody at all.
    calls = [];
    await postEventLine(db(), cfg, id, 'Alpha beat Bravo.');
    const plain = calls.find((c) => c.method === 'POST' && c.path.startsWith('/channels/'));
    expect(plain?.body?.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('teardown', () => {
  it('archive and delete take the team roles with the event role', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Kapital', ['111111']);
    discordStub();
    await syncTeamDiscord(db(), cfg, id, NOW);

    calls = [];
    expect(await archiveEventDiscord(db(), cfg, id)).toBe('ok');
    const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deleted).toContain(`/guilds/${GUILD}/roles/EVENT`);
    expect(deleted).toContain(`/guilds/${GUILD}/roles/ROLE1`);
    expect(await listTeamRoles(db(), id)).toEqual([]);
    expect(await listTeamGrants(db(), 1)).toEqual([]);
    // The channels stay for the board to read back.
    expect((await listEventChannels(db(), id)).length).toBe(1);

    expect(await tearDownEventDiscord(db(), cfg, id)).toBe('ok');
    expect(await listEventChannels(db(), id)).toEqual([]);
  });

  it('a purged member loses every team role they held', async () => {
    const id = await seedBigEvent();
    await seedTeam(id, 1, 'Kapital', ['111111']);
    discordStub();
    await syncTeamDiscord(db(), cfg, id, NOW);

    calls = [];
    await stripTeamRoles(db(), cfg, '111111');
    expect(memberCalls()).toEqual(['DELETE 111111/roles/ROLE1']);
    expect(await listTeamGrants(db(), 1)).toEqual([]);
  });
});
