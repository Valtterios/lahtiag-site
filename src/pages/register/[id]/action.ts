import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../../lib/guard';
import { requireBoard } from '../../../lib/board';
import {
  decideApplication,
  updateRegisterEntry,
  setRegisterStatus,
  eraseRegisterEntry,
  resolveLinkRequest,
  setActive,
  getRegisterEntry,
  mergeApplicationInto,
  RuleError,
} from '../../../lib/db';
import { parseApplication, LIMITS, MEMBER_TYPES, type MemberType } from '../../../lib/register';
import { applyRoles, loadRoleConfig, type RoleOutcome } from '../../../lib/roles';
import { postWebhook } from '../../../lib/discord';
import { postBoardLine, postActivesRequest } from '../../../lib/board-channel';

// A new member is welcomed in a public channel when WELCOME_WEBHOOK_URL is
// set: a mention if their Discord is linked, their handle if they gave one,
// nothing otherwise (the register's names stay in the register).
async function welcome(id: number): Promise<void> {
  if (!env.WELCOME_WEBHOOK_URL) return;
  const entry = await getRegisterEntry(env.DB, id);
  if (!entry) return;
  const who = entry.discord_id ? `<@${entry.discord_id}>` : entry.discord_name ? `@${entry.discord_name.replace(/^@/, '')}` : null;
  if (!who) return;
  await postWebhook(env.WELCOME_WEBHOOK_URL, `🎉 ${who} joined as a member! Welcome to LahtiAG.`, {
    parse: [],
    users: entry.discord_id ? [entry.discord_id] : [],
  });
}

// Every board write on one register entry, dispatched on `action`:
// approve | reject | update | former | member | erase | link_confirm |
// link_dismiss | active_approve | active_revoke | merge (into `target`).
// After a change that
// affects Discord roles the entry's roles are brought in line; a failure
// there is reported, never blocks the register change. Google step-up
// (board.ts) and CSRF checked, like every register route.

export const POST: APIRoute = async ({ request, redirect, params, url, locals }) => {
  const id = Number(params.id);
  const back = Number.isInteger(id) ? `/register/${id}` : '/register';
  const board = await requireBoard(request, env);
  if (!board.ok) return redirect(`${back}?err=${board.reason}`, 303);
  if (!Number.isInteger(id)) return redirect('/register?err=missing', 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const action = String(form.get('action') ?? '');
  const now = Math.floor(Date.now() / 1000);
  // The redirect carries whether Discord roles could be set, so the page
  // can say so next to the success message.
  const done = (target: string, roles?: RoleOutcome) =>
    redirect(roles && roles.failed.length > 0 ? `${target}&roles=failed` : target, 303);
  const roleCfg = await loadRoleConfig(env, env.DB);
  const sync = async () => {
    const entry = await getRegisterEntry(env.DB, id);
    return entry ? applyRoles(roleCfg, entry) : undefined;
  };

  // The board channel hears every decision, whoever made it and where.
  const tellBoard = (line: string) => locals.cfContext.waitUntil(postBoardLine(env.DB, env, line));

  try {
    switch (action) {
      case 'approve': {
        await decideApplication(env.DB, id, 'approve', board.email, now);
        const roles = await sync();
        await welcome(id);
        const member = await getRegisterEntry(env.DB, id);
        tellBoard(`✅ **${member?.full_name ?? id}** approved as a member by ${board.email}.`);
        // They ticked "I'd like to be an active" on the application form:
        // that is a second decision, still open, so it goes to the board
        // channel with its buttons like any other actives request. Without
        // this it only ever showed on the register.
        if (member?.wants_active && !member.is_active) {
          locals.cfContext.waitUntil(postActivesRequest(env.DB, env, member, url.origin));
        }
        return done('/register?ok=approved', roles);
      }
      case 'reject': {
        const before = await getRegisterEntry(env.DB, id);
        await decideApplication(env.DB, id, 'reject', board.email, now);
        tellBoard(`❌ **${before?.full_name ?? id}**'s application declined by ${board.email}.`);
        const roles = before?.discord_id
          ? await applyRoles(roleCfg, { status: 'former', is_active: false, discord_id: before.discord_id })
          : undefined;
        return done('/register?ok=rejected', roles);
      }
      case 'link_confirm':
        await resolveLinkRequest(env.DB, id, 'confirm', now);
        return done('/register?ok=linked', await sync());
      case 'link_dismiss':
        await resolveLinkRequest(env.DB, id, 'dismiss', now);
        return redirect('/register?ok=link_dismissed', 303);
      case 'former':
      case 'member':
        await setRegisterStatus(env.DB, id, action, now);
        return done(`${back}?ok=${action}`, await sync());
      case 'merge': {
        const target = Number(form.get('target'));
        if (!Number.isInteger(target)) return redirect(`${back}?err=bad_input`, 303);
        const merged = await mergeApplicationInto(env.DB, id, target, now);
        return done(`/register/${target}?ok=merged`, await applyRoles(roleCfg, merged));
      }
      case 'active_approve':
      case 'active_revoke': {
        const entry = await setActive(env.DB, id, action === 'active_approve', board.email, now);
        tellBoard(action === 'active_approve' ? `✅ **${entry.full_name}** is an active now, approved by ${board.email}.` : `↩️ **${entry.full_name}** is no longer an active (by ${board.email}).`);
        return done(`${back}?ok=${action}`, await applyRoles(roleCfg, entry));
      }
      case 'erase': {
        const before = await getRegisterEntry(env.DB, id);
        const gone = await eraseRegisterEntry(env.DB, id);
        const roles = before?.discord_id
          ? await applyRoles(roleCfg, { status: 'former', is_active: false, discord_id: before.discord_id })
          : undefined;
        return gone ? done('/register?ok=erased', roles) : redirect('/register?err=missing', 303);
      }
      case 'update': {
        const parsed = parseApplication(form, false);
        if (!parsed.ok) return redirect(`${back}?err=bad_input`, 303);
        const discordIdRaw = String(form.get('discord_id') ?? '').trim();
        if (discordIdRaw && !/^\d{5,25}$/.test(discordIdRaw)) {
          return redirect(`${back}?err=bad_input`, 303);
        }
        const boardNote = String(form.get('board_note') ?? '')
          .trim()
          .slice(0, LIMITS.board_note);
        const typeRaw = String(form.get('member_type') ?? '');
        const memberType = MEMBER_TYPES.find((t): t is MemberType => t === typeRaw);
        if (!memberType) return redirect(`${back}?err=bad_input`, 303);
        const before = await getRegisterEntry(env.DB, id);
        await updateRegisterEntry(
          env.DB,
          id,
          parsed.value,
          { discord_id: discordIdRaw || null, board_note: boardNote || null, member_type: memberType },
          now,
        );
        // A link changed by hand: strip the old account, set up the new one.
        let roles: RoleOutcome | undefined;
        if (before?.discord_id && before.discord_id !== (discordIdRaw || null)) {
          roles = await applyRoles(roleCfg, { status: 'former', is_active: false, discord_id: before.discord_id });
        }
        const after = await sync();
        if (after && (!roles || after.failed.length > 0)) roles = after;
        return done(`${back}?ok=saved`, roles);
      }
      default:
        return redirect(`${back}?err=bad_input`, 303);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
