import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { setUpEventDiscord, syncEventRole, tearDownEventDiscord, syncScheduledEvent, upgradeEventDiscord, createTeamVoiceChannels, archiveEventDiscord } from '../../../lib/event-discord';

// Board: give the event its Discord role and channel (or own category),
// upgrade one to a category, make team voice channels, sync the role
// against the roster, archive or delete it all, or (re)make the Discord
// scheduled event for one published before the bot did that.

export const POST: APIRoute = async ({ request, params, redirect, url }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  const now = Math.floor(Date.now() / 1000);
  const action = String(form.get('action') ?? '');

  if (action === 'event') {
    const result = await syncScheduledEvent(env.DB, env, id, url.origin, now, true);
    if (result === 'created' || result === 'updated') return redirect(`${back}?ok=discord_event_created#discord`, 303);
    if (result === 'removed') return redirect(`${back}?ok=discord_event_removed#discord`, 303);
    return redirect(`${back}?err=discord_${result === 'skipped' ? 'event_skipped' : result}`, 303);
  }
  if (action === 'create') {
    const size = form.get('size') === 'category' ? 'category' : 'channel';
    const result = await setUpEventDiscord(env.DB, env, id, url.origin, admin.session.discordId, now, size);
    if (!result.ok) return redirect(`${back}?err=discord_${result.reason}`, 303);
    return redirect(`${back}?ok=discord_created#discord`, 303);
  }
  if (action === 'upgrade') {
    const result = await upgradeEventDiscord(env.DB, env, id, url.origin, now);
    if (result !== 'ok') return redirect(`${back}?err=discord_${result}`, 303);
    return redirect(`${back}?ok=discord_upgraded#discord`, 303);
  }
  if (action === 'team_voice') {
    const result = await createTeamVoiceChannels(env.DB, env, id, now);
    if (!result.ok) return redirect(`${back}?err=discord_${result.reason}`, 303);
    return redirect(`${back}?ok=discord_team_voice&c=${result.created}&x=${result.removed}&t=${result.teams}#discord`, 303);
  }
  if (action === 'archive') {
    const result = await archiveEventDiscord(env.DB, env, id);
    if (result === 'partial') return redirect(`${back}?err=discord_partial`, 303);
    return redirect(`${back}?ok=discord_archived#discord`, 303);
  }
  if (action === 'sync') {
    const summary = await syncEventRole(env.DB, env, id, now);
    if (!summary) return redirect(`${back}?err=discord_unconfigured`, 303);
    const q = new URLSearchParams({ ok: 'discord_synced', a: String(summary.added), r: String(summary.removed), m: String(summary.notInServer), f: String(summary.forbidden + summary.failed), left: String(summary.remaining) });
    return redirect(`${back}?${q}#discord`, 303);
  }
  if (action === 'remove') {
    const result = await tearDownEventDiscord(env.DB, env, id);
    if (result === 'partial') return redirect(`${back}?err=discord_partial`, 303);
    return redirect(`${back}?ok=discord_removed#discord`, 303);
  }
  return redirect(`${back}?err=csrf`, 303);
};
