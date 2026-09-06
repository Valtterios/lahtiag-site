import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { purgeMember } from '../../lib/db';
import { syncMemberEventRoles } from '../../lib/event-discord';
import { announcePromotions } from '../../lib/event-channel';

// Erase a member's participation everywhere — ban cleanup and the
// GDPR-erasure path. Admin only, from the form on /events.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/events?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/events?err=csrf', 303);

  const discordId = String(form.get('discord_id') ?? '').trim();
  if (!/^\d{5,25}$/.test(discordId)) return redirect('/events?err=bad_input', 303);

  await purgeMember(env.DB, discordId);
  // Any per-event Discord role they held goes with the signups.
  await syncMemberEventRoles(env.DB, env, discordId, Math.floor(Date.now() / 1000));
  await announcePromotions(env.DB, env, Math.floor(Date.now() / 1000));
  return redirect('/events?ok=purged', 303);
};
