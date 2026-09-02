import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../lib/guard';
import { addTeamMember, createTeam, ensureMember, removeTeamMember, RuleError } from '../../lib/db';

// One admin endpoint for the three roster operations; the web form and the
// bot's /roster commands both end in the same db.ts functions.

export const POST: APIRoute = async ({ request, redirect }) => {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`/teams?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect('/teams?err=csrf', 303);

  const action = String(form.get('action') ?? '');
  const now = Math.floor(Date.now() / 1000);

  try {
    if (action === 'create') {
      await createTeam(env.DB, String(form.get('name') ?? ''), String(form.get('game') ?? ''));
    } else if (action === 'add') {
      const discordId = String(form.get('discord_id') ?? '').trim();
      if (!/^\d+$/.test(discordId)) return redirect('/teams?err=bad_input', 303);
      // Rosters can include people who have never signed in; give them a
      // display-cache row so the page has something to show. Insert-only:
      // a real cached name from an earlier login must survive this.
      await ensureMember(env.DB, discordId, `member ${discordId.slice(-4)}`, now);
      await addTeamMember(
        env.DB,
        Number(form.get('team_id')),
        discordId,
        String(form.get('position') ?? '').trim() || null,
        now,
      );
    } else if (action === 'remove') {
      await removeTeamMember(env.DB, Number(form.get('team_id')), String(form.get('discord_id') ?? ''));
    } else {
      return redirect('/teams?err=bad_input', 303);
    }
  } catch (error) {
    if (error instanceof RuleError) return redirect(`/teams?err=${error.code}`, 303);
    throw error;
  }
  return redirect('/teams', 303);
};
