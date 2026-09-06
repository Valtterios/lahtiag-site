import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { updateEvent, getEvent, setSignupsOpenAt, RuleError } from '../../../lib/db';
import { renameEventDiscord, syncScheduledEvent } from '../../../lib/event-discord';
import { later, postEventLine, changeLine, announcePromotionsInBackground } from '../../../lib/event-channel';
import { helsinkiToUnix } from '../../../lib/time';
import { editWebhookMessage, eventAnnouncement } from '../../../lib/discord';

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
    });
    await setSignupsOpenAt(env.DB, id, opensAt);
    // Edit the original Discord announcement in place instead of reposting.
    if (event.discord_message_id && env.DISCORD_WEBHOOK_URL) {
      await editWebhookMessage(
        env.DISCORD_WEBHOOK_URL,
        event.discord_message_id,
        eventAnnouncement({
          title: event.title,
          startsAt: event.starts_at,
          endsAt: event.ends_at,
          organizers: event.organizers,
          teamSize: event.team_size,
          url: `${url.origin}/events/${id}`,
        }),
      );
    }
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
