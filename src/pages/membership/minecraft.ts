import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../lib/guard';
import { RuleError } from '../../lib/db';
import { setOwnMinecraftName, addMinecraftFriend, removeMinecraftName, friendRequestLine, grantMinecraftRole } from '../../lib/minecraft';
import { postBoardLine, approveButtons } from '../../lib/board-channel';
import { dmUser } from '../../lib/discord';

// A member's names on the Minecraft whitelist: their own, a friend, or one
// off the list. The server picks the change up on its next pull.

export const POST: APIRoute = async ({ request, redirect, url, locals }) => {
  const session = await currentSession(request, env);
  if (!session) return redirect('/membership?err=signin', 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/membership?err=csrf', 303);
  const action = String(form.get('action') ?? '');
  const name = String(form.get('name') ?? '');
  const servers = String(form.get('servers') ?? 'all');
  const now = Math.floor(Date.now() / 1000);
  try {
    if (action === 'own') {
      const own = await setOwnMinecraftName(env.DB, session.discordId, name, now);
      locals.cfContext.waitUntil(grantMinecraftRole(env, session.discordId)); // the Minecraft channels open with the name
      // The member who had brought them as a friend gets their slot back.
      if (own.takenFrom && env.DISCORD_BOT_TOKEN) {
        locals.cfContext.waitUntil(dmUser(env.DISCORD_BOT_TOKEN, own.takenFrom, `**${own.name}** is a member now and took their whitelist name with them. Your friend slot is free again: ${url.origin}/membership#minecraft`));
      }
    }
    else if (action === 'friend') {
      const friend = await addMinecraftFriend(env.DB, session.discordId, name, now, undefined, servers);
      // The board decides; its channel gets the request with Approve / Decline.
      // A name the board had listed already is on without asking again.
      if (friend.approved) return redirect('/membership?ok=mc_friend_on#minecraft', 303);
      locals.cfContext.waitUntil(postBoardLine(env.DB, env, friendRequestLine(session.username, friend.name, servers === 'all' ? '' : servers, url.origin), approveButtons('w', friend.name)));
    }
    else if (action === 'remove') await removeMinecraftName(env.DB, session.discordId, name);
    else return redirect('/membership?err=mc_bad#minecraft', 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`/membership?err=mc_${error.code}#minecraft`, 303);
    throw error;
  }
  return redirect(`/membership?ok=mc_${action}#minecraft`, 303);
};
