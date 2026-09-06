import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { approveMinecraftName, declineMinecraftName, dropMinecraftName, linkBoardName } from '../../lib/minecraft';
import { RuleError } from '../../lib/db';
import { dmUser } from '../../lib/discord';
import { postBoardLine } from '../../lib/board-channel';

// The board's decisions on the whitelist table: approve or decline a
// friend, drop any name, or link a board name to the member it belongs
// to. The member concerned hears by DM.

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
  if (action === 'link') {
    const discordId = String(form.get('discord_id') ?? '');
    if (!/^\d{17,20}$/.test(discordId)) return redirect('/whitelist?err=bad_input', 303);
    try {
      const row = await linkBoardName(env.DB, name, discordId, admin.session.discordId, now);
      if (token) await dmUser(token, discordId, `⛏️ The board linked the Minecraft name **${row.name}** to you: it is on the whitelist as yours, on every server, and follows your membership. ${url.origin}/membership#minecraft`);
      locals.cfContext.waitUntil(postBoardLine(env.DB, env, `⛏️ Whitelist: **${row.name}** linked to <@${discordId}> by ${admin.session.username}.`));
      return redirect('/whitelist?ok=linked', 303);
    } catch (error) {
      if (error instanceof RuleError) return redirect(`/whitelist?err=${error.code}`, 303);
      throw error;
    }
  }
  return redirect('/whitelist?err=bad_input', 303);
};
