import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { desiredRoles, planRoleChanges, rolesConfigured, loadRoleConfig, linkWarnings } from '../src/lib/roles';
import { sameHandle } from '../src/lib/register';
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

describe('linkWarnings', () => {
  it('flags ids missing from the server and names that do not match the account', () => {
    const entries = [
      { id: 1, full_name: 'A', discord_id: '1', discord_name: 'alpha' },
      { id: 2, full_name: 'B', discord_id: '2', discord_name: 'Beta#1234' },
      { id: 3, full_name: 'C', discord_id: '3', discord_name: 'wrongname' },
      { id: 4, full_name: 'D', discord_id: '4', discord_name: null },
      { id: 5, full_name: 'E', discord_id: null, discord_name: 'nobody' },
    ] as never[];
    const members = new Map([
      ['1', { roles: [], username: 'alpha', display: 'Alpha' }],
      ['2', { roles: [], username: 'beta', display: 'B' }],
      ['3', { roles: [], username: 'gamma', display: 'Gamma' }],
    ]);
    const out = linkWarnings(entries, members, sameHandle).map((w) => `${w.entry.id}:${w.problem}:${w.actual ?? ''}`);
    expect(out).toEqual(['3:name_differs:gamma', '4:not_in_server:']);
  });
});
