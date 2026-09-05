// Discord roles that mirror the register: Member for current members,
// Actives for board-approved actives, both only for entries with a linked
// Discord account. Off entirely until the bot token and the role ids are
// configured; every caller degrades to "roles not set" rather than failing.

import type { D1Database } from '@cloudflare/workers-types';
import { DISCORD_GUILD_ID } from './config';
import { setGuildMemberRole, listGuildMemberRoles, type RoleResult, type GuildMemberInfo } from './discord';
import { listLinkedEntries, getSettings, type RegisterRow } from './db';

export interface RoleConfig {
  DISCORD_BOT_TOKEN?: string;
  MEMBER_ROLE_ID?: string;
  ACTIVES_ROLE_ID?: string;
}

// The role ids are chosen on the register page and stored in `settings`;
// the wrangler.toml vars remain as a fallback. The token is a secret.
export async function loadRoleConfig(
  env: { DISCORD_BOT_TOKEN?: string; MEMBER_ROLE_ID?: string; ACTIVES_ROLE_ID?: string },
  db: D1Database,
): Promise<RoleConfig> {
  const settings = await getSettings(db);
  return {
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    MEMBER_ROLE_ID: settings.member_role_id ?? env.MEMBER_ROLE_ID ?? '',
    ACTIVES_ROLE_ID: settings.actives_role_id ?? env.ACTIVES_ROLE_ID ?? '',
  };
}

export function rolesConfigured(env: RoleConfig): boolean {
  return Boolean(env.DISCORD_BOT_TOKEN && (env.MEMBER_ROLE_ID || env.ACTIVES_ROLE_ID));
}

// Which of the two roles an entry should hold, from its register state.
export function desiredRoles(
  entry: Pick<RegisterRow, 'status' | 'is_active' | 'discord_id'>,
  env: RoleConfig,
): string[] {
  if (!entry.discord_id || entry.status !== 'member') return [];
  const roles: string[] = [];
  if (env.MEMBER_ROLE_ID) roles.push(env.MEMBER_ROLE_ID);
  if (env.ACTIVES_ROLE_ID && entry.is_active) roles.push(env.ACTIVES_ROLE_ID);
  return roles;
}

export interface RoleOutcome {
  changed: number;
  failed: RoleResult[];
}

// Bring one entry's roles in line, unconditionally (add and remove are
// idempotent on Discord). `discordId` may be passed for an entry that just
// lost its link or was erased, so the roles can be taken away.
export async function applyRoles(
  env: RoleConfig,
  entry: Pick<RegisterRow, 'status' | 'is_active' | 'discord_id'>,
  discordId: string | null = entry.discord_id,
): Promise<RoleOutcome> {
  const outcome: RoleOutcome = { changed: 0, failed: [] };
  if (!rolesConfigured(env) || !discordId) return outcome;
  const wanted = new Set(desiredRoles({ ...entry, discord_id: discordId }, env));
  for (const roleId of [env.MEMBER_ROLE_ID, env.ACTIVES_ROLE_ID]) {
    if (!roleId) continue;
    const result = await setGuildMemberRole(
      env.DISCORD_BOT_TOKEN!,
      DISCORD_GUILD_ID,
      discordId,
      roleId,
      wanted.has(roleId),
    );
    if (result === 'ok') outcome.changed++;
    else if (result !== 'not_in_guild') outcome.failed.push(result);
  }
  return outcome;
}

export interface RoleChange {
  discordId: string;
  roleId: string;
  on: boolean;
}

// The sync's plan: compare what the server says against what the register
// wants, for every linked entry and for anyone holding a managed role
// without being entitled to it. Pure, so it is testable.
export function planRoleChanges(
  entries: Pick<RegisterRow, 'status' | 'is_active' | 'discord_id'>[],
  guildRoles: Map<string, string[]>,
  env: RoleConfig,
): RoleChange[] {
  const managed = [env.MEMBER_ROLE_ID, env.ACTIVES_ROLE_ID].filter((r): r is string => Boolean(r));
  const wantedByUser = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.discord_id) continue;
    wantedByUser.set(entry.discord_id, new Set(desiredRoles(entry, env)));
  }
  const changes: RoleChange[] = [];
  for (const [discordId, wanted] of wantedByUser) {
    const has = guildRoles.get(discordId);
    if (!has) continue; // not in the server: nothing to set
    for (const roleId of managed) {
      const should = wanted.has(roleId);
      if (should !== has.includes(roleId)) changes.push({ discordId, roleId, on: should });
    }
  }
  for (const [discordId, has] of guildRoles) {
    if (wantedByUser.has(discordId)) continue;
    for (const roleId of managed) {
      if (has.includes(roleId)) changes.push({ discordId, roleId, on: false });
    }
  }
  return changes;
}

// What a sync would do right now, for showing on the register before
// anyone clicks. 'intent' = the bot cannot list members (Server Members
// intent off in the Developer Portal).
export type RolePlan =
  | { ok: true; changes: RoleChange[]; members: Map<string, GuildMemberInfo> }
  | { ok: false; reason: 'unconfigured' | 'intent' | 'error' };

export async function planRoles(env: RoleConfig, db: D1Database): Promise<RolePlan> {
  if (!rolesConfigured(env)) return { ok: false, reason: 'unconfigured' };
  const members = await listGuildMemberRoles(env.DISCORD_BOT_TOKEN!, DISCORD_GUILD_ID);
  if (!members.ok) return { ok: false, reason: members.reason };
  return { ok: true, changes: planRoleChanges(await listLinkedEntries(db), members.roles, env), members: members.members };
}

export interface LinkWarning {
  entry: RegisterRow;
  problem: 'not_in_server' | 'name_differs';
  actual: string | null; // the account's real handle when known
}

// Linked IDs pasted by hand can be wrong. Against the server's member
// list: an ID nobody in the server has, or a stored Discord name that
// isn't the account's handle.
export function linkWarnings(
  entries: RegisterRow[],
  members: Map<string, GuildMemberInfo>,
  same: (a: string | null, b: string | null) => boolean,
): LinkWarning[] {
  const out: LinkWarning[] = [];
  for (const entry of entries) {
    if (!entry.discord_id) continue;
    const info = members.get(entry.discord_id);
    if (!info) {
      out.push({ entry, problem: 'not_in_server', actual: null });
    } else if (entry.discord_name && !same(entry.discord_name, info.username) && !same(entry.discord_name, info.display)) {
      out.push({ entry, problem: 'name_differs', actual: info.username });
    }
  }
  return out;
}

export interface SyncSummary {
  planned: number;
  applied: number;
  forbidden: number; // Discord refused: the bot's role sits below the target role, or Manage Roles is missing
  failed: number;
  remaining: number;
  error: 'unconfigured' | 'intent' | 'error' | null;
}

// Workers allow a limited number of outgoing requests per invocation, so
// one click applies at most `limit` changes and says how many are left.
export async function syncAllRoles(env: RoleConfig, db: D1Database, limit = 40): Promise<SyncSummary> {
  const plan = await planRoles(env, db);
  if (!plan.ok) return { planned: 0, applied: 0, forbidden: 0, failed: 0, remaining: 0, error: plan.reason };
  let applied = 0;
  let forbidden = 0;
  let failed = 0;
  for (const change of plan.changes.slice(0, limit)) {
    const result = await setGuildMemberRole(
      env.DISCORD_BOT_TOKEN!,
      DISCORD_GUILD_ID,
      change.discordId,
      change.roleId,
      change.on,
    );
    if (result === 'ok' || result === 'not_in_guild') applied++;
    else if (result === 'forbidden') forbidden++;
    else failed++;
  }
  return {
    planned: plan.changes.length,
    applied,
    forbidden,
    failed,
    remaining: Math.max(0, plan.changes.length - limit),
    error: null,
  };
}
