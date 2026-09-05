import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { createEvent, RuleError } from '../../lib/db';
import { helsinkiToUnix } from '../../lib/time';

// A new event starts as a draft: only the board sees it, nothing goes to
// Discord, until Publish on the event page.

export const POST: APIRoute = async ({ request, redirect, url }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/events?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/events?err=csrf', 303);

  const startsAt = helsinkiToUnix(String(form.get('date') ?? ''), String(form.get('time') ?? ''));
  if (startsAt === null) return redirect('/events?err=bad_time', 303);
  let endsAt = helsinkiToUnix(String(form.get('date') ?? ''), String(form.get('end_time') ?? ''));
  if (endsAt === null) return redirect('/events?err=bad_time', 303);
  // An end at or before the start means the event runs past midnight.
  if (endsAt <= startsAt) endsAt += 86400;

  const capacityRaw = String(form.get('capacity') ?? '').trim();
  const teamSizeRaw = String(form.get('team_size') ?? '').trim();
  const organizers = String(form.get('organizers') ?? '').trim();
  const location = String(form.get('location') ?? '').trim();
  const linkUrl = String(form.get('link_url') ?? '').trim();
  const membersOnly = form.get('members_only') === 'on';
  const memberSlotsRaw = String(form.get('member_slots') ?? '').trim();
  const memberSlots = memberSlotsRaw ? Number(memberSlotsRaw) : null;
  const description = String(form.get('description') ?? '').trim();

  try {
    const now = Math.floor(Date.now() / 1000);
    const teamSize = teamSizeRaw ? Number(teamSizeRaw) : null;
    const id = await createEvent(
      env.DB,
      {
        title: String(form.get('title') ?? ''),
        description: description || null,
        starts_at: startsAt,
        ends_at: endsAt,
        capacity: capacityRaw ? Number(capacityRaw) : null,
        team_size: teamSize,
        organizers: organizers || null,
        location: location || null,
        link_url: linkUrl || null,
        members_only: membersOnly,
        member_slots: memberSlots,
        created_by: admin.session.discordId,
        published: false,
      },
      now,
    );
    return redirect(`/events/${id}?ok=draft`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect('/events?err=bad_input', 303);
    throw error;
  }
};
