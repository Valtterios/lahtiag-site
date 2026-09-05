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
  RuleError,
} from '../../../lib/db';
import { parseApplication, LIMITS, MEMBER_TYPES, type MemberType } from '../../../lib/register';
import { applyRoles, type RoleOutcome } from '../../../lib/roles';

// Every board write on one register entry, dispatched on `action`:
// approve | reject | update | former | member | erase | link_confirm |
// link_dismiss | active_approve | active_revoke. After a change that
// affects Discord roles the entry's roles are brought in line; a failure
// there is reported, never blocks the register change. Google step-up
// (board.ts) and CSRF checked, like every register route.

export const POST: APIRoute = async ({ request, redirect, params }) => {
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
  const sync = async () => {
    const entry = await getRegisterEntry(env.DB, id);
    return entry ? applyRoles(env, entry) : undefined;
  };

  try {
    switch (action) {
      case 'approve':
        await decideApplication(env.DB, id, 'approve', board.email, now);
        return done('/register?ok=approved', await sync());
      case 'reject': {
        const before = await getRegisterEntry(env.DB, id);
        await decideApplication(env.DB, id, 'reject', board.email, now);
        const roles = before?.discord_id
          ? await applyRoles(env, { status: 'former', is_active: false, discord_id: before.discord_id })
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
      case 'active_approve':
      case 'active_revoke': {
        const entry = await setActive(env.DB, id, action === 'active_approve', board.email, now);
        return done(`${back}?ok=${action}`, await applyRoles(env, entry));
      }
      case 'erase': {
        const before = await getRegisterEntry(env.DB, id);
        const gone = await eraseRegisterEntry(env.DB, id);
        const roles = before?.discord_id
          ? await applyRoles(env, { status: 'former', is_active: false, discord_id: before.discord_id })
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
          roles = await applyRoles(env, { status: 'former', is_active: false, discord_id: before.discord_id });
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
