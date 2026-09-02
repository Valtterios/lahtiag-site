import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { createEvent, setEventMessageId, RuleError } from '../../lib/db';
import { helsinkiToUnix, formatHelsinki } from '../../lib/time';
import { postWebhook } from '../../lib/discord';

export const POST: APIRoute = async ({ request, redirect, url }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/events?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/events?err=csrf', 303);

  const startsAt = helsinkiToUnix(String(form.get('date') ?? ''), String(form.get('time') ?? ''));
  if (startsAt === null) return redirect('/events?err=bad_time', 303);

  const capacityRaw = String(form.get('capacity') ?? '').trim();
  const teamRaw = String(form.get('team_id') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();

  try {
    const now = Math.floor(Date.now() / 1000);
    const id = await createEvent(
      env.DB,
      {
        title: String(form.get('title') ?? ''),
        description: description || null,
        starts_at: startsAt,
        capacity: capacityRaw ? Number(capacityRaw) : null,
        team_id: teamRaw ? Number(teamRaw) : null,
        created_by: admin.session.discordId,
      },
      now,
    );
    // Both surfaces stay consistent regardless of where the change
    // originated (spec): website writes mirror to Discord when the webhook
    // is configured, and the message id is kept for later edits.
    if (env.DISCORD_WEBHOOK_URL) {
      const messageId = await postWebhook(
        env.DISCORD_WEBHOOK_URL,
        `📅 **${String(form.get('title') ?? '').trim()}** — ${formatHelsinki(startsAt)}\nSign up: ${url.origin}/events/${id}`,
      );
      if (messageId) await setEventMessageId(env.DB, id, messageId);
    }
    return redirect(`/events/${id}`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect('/events?err=bad_input', 303);
    throw error;
  }
};
