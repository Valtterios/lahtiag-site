import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { desiredRoles, planRoleChanges, rolesConfigured, loadRoleConfig } from '../src/lib/roles';
import { setSetting, getSettings } from '../src/lib/db';

// The Discord role mirror, as pure planning: which roles an entry should
// have, and what the sync would change given what the server reports.

const cfg = { DISCORD_BOT_TOKEN: 'tok', MEMBER_ROLE_ID: 'M', ACTIVES_ROLE_ID: 'A' };

describe('desiredRoles', () => {
  it('follows status, approval and the link', () => {
    expect(desiredRoles({ status: 'member', is_active: true, discord_id: '1' }, cfg)).toEqual(['M', 'A']);
    expect(desiredRoles({ status: 'member', is_active: false, discord_id: '1' }, cfg)).toEqual(['M']);
    expect(desiredRoles({ status: 'pending', is_active: false, discord_id: '1' }, cfg)).toEqual([]);
    expect(desiredRoles({ status: 'former', is_active: true, discord_id: '1' }, cfg)).toEqual([]);
    expect(desiredRoles({ status: 'member', is_active: true, discord_id: null }, cfg)).toEqual([]);
    expect(desiredRoles({ status: 'member', is_active: true, discord_id: '1' }, { ...cfg, ACTIVES_ROLE_ID: '' })).toEqual(['M']);
  });

  it('is off without a token or without any role id', () => {
    expect(rolesConfigured(cfg)).toBe(true);
    expect(rolesConfigured({ ...cfg, DISCORD_BOT_TOKEN: undefined })).toBe(false);
    expect(rolesConfigured({ DISCORD_BOT_TOKEN: 'tok', MEMBER_ROLE_ID: '', ACTIVES_ROLE_ID: '' })).toBe(false);
  });
});

describe('planRoleChanges', () => {
  it('adds what is missing, removes what is extra, ignores people not in the server', () => {
    const entries = [
      { status: 'member' as const, is_active: true, discord_id: '1' }, // should have M+A, has M
      { status: 'member' as const, is_active: false, discord_id: '2' }, // should have M, has M+A
      { status: 'former' as const, is_active: false, discord_id: '3' }, // should have none, has M
      { status: 'member' as const, is_active: false, discord_id: '4' }, // not in the server
      { status: 'member' as const, is_active: true, discord_id: null },
    ];
    const guild = new Map<string, string[]>([
      ['1', ['x', 'M']],
      ['2', ['M', 'A']],
      ['3', ['M']],
      ['9', ['A']], // holds a managed role without any entry
      ['8', ['x']], // unrelated
    ]);
    const changes = planRoleChanges(entries, guild, cfg).map((c) => `${c.discordId}:${c.roleId}:${c.on ? '+' : '-'}`).sort();
    expect(changes).toEqual(['1:A:+', '2:A:-', '3:M:-', '9:A:-']);
  });
});

describe('loadRoleConfig', () => {
  it('prefers the roles chosen on the register page over the vars, and forgets a cleared one', async () => {
    await env.DB.prepare('DELETE FROM settings').run();
    const vars = { DISCORD_BOT_TOKEN: 'tok', MEMBER_ROLE_ID: 'varM', ACTIVES_ROLE_ID: '' };
    expect(await loadRoleConfig(vars, env.DB)).toEqual({ DISCORD_BOT_TOKEN: 'tok', MEMBER_ROLE_ID: 'varM', ACTIVES_ROLE_ID: '' });
    await setSetting(env.DB, 'member_role_id', 'dbM', 'chair', 1);
    await setSetting(env.DB, 'actives_role_id', 'dbA', 'chair', 1);
    expect(await loadRoleConfig(vars, env.DB)).toMatchObject({ MEMBER_ROLE_ID: 'dbM', ACTIVES_ROLE_ID: 'dbA' });
    await setSetting(env.DB, 'actives_role_id', '', 'chair', 2);
    expect(await getSettings(env.DB)).toEqual({ member_role_id: 'dbM' });
    expect(await loadRoleConfig(vars, env.DB)).toMatchObject({ MEMBER_ROLE_ID: 'dbM', ACTIVES_ROLE_ID: '' });
  });
});
