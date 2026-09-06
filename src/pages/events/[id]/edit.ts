import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { updateEvent, getEvent, setSignupsOpenAt, demoteOverCapacity, RuleError } from '../../../lib/db';
import { renameEventDiscord, syncScheduledEvent } from '../../../lib/event-discord';
import { dropLiveBracket } from '../../../lib/event-channel';
import { later, postEventLine, changeLine, announcePromotionsInBackground, notifyWaitlisted } from '../../../lib/event-channel';
import { syncEventRolesInBackground } from '../../../lib/event-discord';
import { helsinkiToUnix } from '../../../lib/time';
import { refreshEventAnnouncement } from '../../../lib/announce';

export const POST: APIRoute = async ({ request, params, redirect, url, locals }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const startsAt = helsinkiToUnix(String(form.get('date') ?? ''), String(form.get('time') ?? ''));
  if (startsAt === null) return redirect(`${back}?err=bad_time`, 303);
  let endsAt = helsinkiToUnix(String(form.get('date') ?? ''), String(form.get('end_time') ?? ''));
  if (endsAt === null) return redirect(`${back}?err=bad_time`, 303);
  if (endsAt <= startsAt) endsAt += 86400;

  // Signups open at: both fields empty means from publication.
  const openDate = String(form.get('open_date') ?? '').trim();
  const openTime = String(form.get('open_time') ?? '').trim();
  const opensAt = openDate === '' && openTime === '' ? null : helsinkiToUnix(openDate, openTime || '00:00');
  if (opensAt === null && (openDate !== '' || openTime !== '')) return redirect(`${back}?err=bad_time`, 303);
  const capacityRaw = String(form.get('capacity') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const organizers = String(form.get('organizers') ?? '').trim();
  const location = String(form.get('location') ?? '').trim();
  const linkUrl = String(form.get('link_url') ?? '').trim();
  const membersOnly = form.get('members_only') === 'on';
  const memberSlotsRaw = String(form.get('member_slots') ?? '').trim();
  const memberSlots = memberSlotsRaw ? Number(memberSlotsRaw) : null;
  const teamSizeRaw = String(form.get('team_size') ?? '').trim();
  const teamSize = teamSizeRaw === '' ? null : Number(teamSizeRaw);

  try {
    const before = await getEvent(env.DB, id);
    const event = await updateEvent(env.DB, id, {
      title: String(form.get('title') ?? ''),
      description: description || null,
      starts_at: startsAt,
      ends_at: endsAt,
      capacity: capacityRaw ? Number(capacityRaw) : null,
      organizers: organizers || null,
      location: location || null,
      link_url: linkUrl || null,
      members_only: membersOnly,
      member_slots: memberSlots,
      team_size: teamSize,
    });
    await setSignupsOpenAt(env.DB, id, opensAt);
    // A smaller event: the latest signups beyond the new capacity wait, and hear about it.
    if (before && event.capacity !== null && (before.capacity === null || event.capacity < before.capacity)) {
      const demoted = await demoteOverCapacity(env.DB, id);
      if (demoted.length > 0) {
        later(locals.cfContext, notifyWaitlisted(env.DB, env, id, demoted, url.origin));
        syncEventRolesInBackground(locals.cfContext, env.DB, env, [id], Math.floor(Date.now() / 1000));
      }
    }
    // Edit the original Discord announcement in place instead of reposting.
    await refreshEventAnnouncement(env.DB, env, id, url.origin);
    // A changed team size dropped the bracket; its pinned picture goes too.
    if (before && before.team_size !== event.team_size) await dropLiveBracket(env.DB, env, id);
    // A retitled event renames its Discord role and channel to match.
    if (before && before.title !== event.title && (event.discord_role_id || event.discord_channel_id)) {
      await renameEventDiscord(env, event, url.origin);
    }
    // ...and Discord's scheduled event follows the new details.
    await syncScheduledEvent(env.DB, env, id, url.origin, Math.floor(Date.now() / 1000));
    // A new time or place is told to the event's channel; other edits stay quiet.
    const change = before ? changeLine(before, event) : null;
    if (change) later(locals.cfContext, postEventLine(env.DB, env, id, change, true));
    announcePromotionsInBackground(locals.cfContext, env.DB, env, Math.floor(Date.now() / 1000));
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
