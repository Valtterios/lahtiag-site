import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { createAnnouncement, RuleError } from '../../lib/db';

// A new post starts as a draft; Publish on the news page sends it to Discord.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/announcements?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/announcements?err=csrf', 303);

  const title = String(form.get('title') ?? '');
  const body = String(form.get('body') ?? '');

  try {
    const id = await createAnnouncement(
      env.DB,
      { title, body_md: body, author_id: admin.session.discordId, source: 'web', draft: true },
      Math.floor(Date.now() / 1000),
    );
    void id;
  } catch (error) {
    if (error instanceof RuleError) return redirect('/announcements?err=bad_input', 303);
    throw error;
  }
  return redirect('/announcements?ok=draft', 303);
};
