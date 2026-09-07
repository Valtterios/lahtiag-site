import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { deleteAnnouncement } from '../../lib/db';
import { deleteNewsMessages, newsMessages } from '../../lib/news';

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);

  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirect('/announcements', 303);
  const deleted = await deleteAnnouncement(env.DB, id);
  // Clean up the mirrored Discord messages too; the reverse direction does
  // not exist (deleting on Discord never reaches the site).
  const onDiscord = deleted ? newsMessages(deleted) : null;
  if (onDiscord && env.DISCORD_WEBHOOK_URL) await deleteNewsMessages(env.DISCORD_WEBHOOK_URL, onDiscord);
  return redirect('/announcements', 303);
};
