import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf } from '../../lib/guard';
import { requireBoard } from '../../lib/board';
import { setSetting } from '../../lib/db';
import { listGuildRoles } from '../../lib/discord';
import { DISCORD_GUILD_ID } from '../../lib/config';

// Which Discord roles the register mirrors, chosen from the server's own
// list so a stray id cannot be typed in.

export const POST: APIRoute = async ({ request, redirect }) => {
  const board = await requireBoard(request, env);
  if (!board.ok) return redirect(`/register?err=${board.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/register?err=csrf', 303);
  if (!env.DISCORD_BOT_TOKEN) return redirect('/register?err=roles_unconfigured', 303);

  const roles = await listGuildRoles(env.DISCORD_BOT_TOKEN, DISCORD_GUILD_ID);
  if (!roles) return redirect('/register?err=roles_discord', 303);
  const known = new Set(roles.map((r) => r.id));
  const pick = (name: string): string | null => {
    const value = String(form.get(name) ?? '').trim();
    if (value === '') return '';
    return known.has(value) ? value : null;
  };
  const member = pick('member_role_id');
  const actives = pick('actives_role_id');
  if (member === null || actives === null) return redirect('/register?err=bad_role', 303);

  const now = Math.floor(Date.now() / 1000);
  await setSetting(env.DB, 'member_role_id', member, board.email, now);
  await setSetting(env.DB, 'actives_role_id', actives, board.email, now);
  return redirect('/register?ok=roles_saved#roles', 303);
};
