import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { deleteAnnouncement } from '../../lib/db';
import { deleteWebhookMessage } from '../../lib/discord';

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);

  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect('/announcements', 303);
  const deleted = await deleteAnnouncement(env.DB, id);
  // Clean up the mirrored Discord message too; the reverse direction does
  // not exist (deleting on Discord never reaches the site).
  if (deleted?.discord_message_id && env.DISCORD_WEBHOOK_URL) {
    await deleteWebhookMessage(env.DISCORD_WEBHOOK_URL, deleted.discord_message_id);
  }
  return redirect('/announcements', 303);
};
