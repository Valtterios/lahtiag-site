import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, currentSession } from '../../lib/guard';
import { RuleError } from '../../lib/db';
import { setOwnMinecraftName, addMinecraftFriend, removeMinecraftName } from '../../lib/minecraft';

// A member's names on the Minecraft whitelist: their own, a friend, or one
// off the list. The server picks the change up on its next pull.

export const POST: APIRoute = async ({ request, redirect }) => {
  const session = await currentSession(request, env);
  if (!session) return redirect('/membership?err=signin', 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/membership?err=csrf', 303);
  const action = String(form.get('action') ?? '');
  const name = String(form.get('name') ?? '');
  const now = Math.floor(Date.now() / 1000);
  try {
    if (action === 'own') await setOwnMinecraftName(env.DB, session.discordId, name, now);
    else if (action === 'friend') await addMinecraftFriend(env.DB, session.discordId, name, now);
    else if (action === 'remove') await removeMinecraftName(env.DB, session.discordId, name);
    else return redirect('/membership?err=mc_bad#minecraft', 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`/membership?err=mc_${error.code}#minecraft`, 303);
    throw error;
  }
  return redirect(`/membership?ok=mc_${action}#minecraft`, 303);
};
