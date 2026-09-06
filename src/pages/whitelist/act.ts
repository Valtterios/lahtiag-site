import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { approveMinecraftName, declineMinecraftName, dropMinecraftName } from '../../lib/minecraft';
import { dmUser } from '../../lib/discord';
import { postBoardLine } from '../../lib/board-channel';

// The board's decisions on the whitelist table: approve or decline a
// friend, or drop any name. The member who brought the friend hears by DM.

export const POST: APIRoute = async ({ request, redirect, url, locals }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/whitelist?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/whitelist?err=csrf', 303);
  const action = String(form.get('action') ?? '');
  const name = String(form.get('name') ?? '');
  const now = Math.floor(Date.now() / 1000);
  const token = env.DISCORD_BOT_TOKEN;
  if (action === 'approve') {
    const row = await approveMinecraftName(env.DB, name, admin.session.discordId, now);
    if (!row) return redirect('/whitelist?err=missing', 303);
    if (token) await dmUser(token, row.discord_id, `✅ Your friend **${row.name}** is on the whitelist now. The servers pick it up within a few minutes. ${url.origin}/membership#minecraft`);
    // The board channel hears the outcome too, since this didn't happen on its buttons.
    locals.cfContext.waitUntil(postBoardLine(env.DB, env, `✅ Whitelist: **${row.name}** (friend of ${row.by_name ?? row.discord_id}) approved by ${admin.session.username}.`));
    return redirect('/whitelist?ok=approved', 303);
  }
  if (action === 'decline') {
    const row = await declineMinecraftName(env.DB, name);
    if (!row) return redirect('/whitelist?err=missing', 303);
    if (token) await dmUser(token, row.discord_id, `The board didn't approve **${row.name}** for the whitelist. Ask a board member if you want to know more.`);
    locals.cfContext.waitUntil(postBoardLine(env.DB, env, `❌ Whitelist: **${row.name}** (friend of ${row.by_name ?? row.discord_id}) declined by ${admin.session.username}.`));
    return redirect('/whitelist?ok=declined', 303);
  }
  if (action === 'drop') {
    const gone = await dropMinecraftName(env.DB, name);
    return redirect(gone ? '/whitelist?ok=dropped' : '/whitelist?err=missing', 303);
  }
  return redirect('/whitelist?err=bad_input', 303);
};
