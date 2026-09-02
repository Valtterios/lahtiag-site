import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { updateEvent, RuleError } from '../../../lib/db';
import { helsinkiToUnix } from '../../../lib/time';
import { editWebhookMessage, eventAnnouncement } from '../../../lib/discord';

export const POST: APIRoute = async ({ request, params, redirect, url }) => {
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

  const capacityRaw = String(form.get('capacity') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const organizers = String(form.get('organizers') ?? '').trim();
  const linkUrl = String(form.get('link_url') ?? '').trim();

  try {
    const event = await updateEvent(env.DB, id, {
      title: String(form.get('title') ?? ''),
      description: description || null,
      starts_at: startsAt,
      ends_at: endsAt,
      capacity: capacityRaw ? Number(capacityRaw) : null,
      organizers: organizers || null,
      link_url: linkUrl || null,
    });
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
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
