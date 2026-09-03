import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { addManualParticipant, RuleError } from '../../../lib/db';

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);

  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);

  const status = String(form.get('status') ?? '');
  if (status !== 'yes' && status !== 'maybe') return redirect(`${back}?err=bad_input`, 303);
  const teamRaw = String(form.get('event_team_id') ?? '').trim();
  const teamId = teamRaw === '' ? null : Number(teamRaw);
  if (teamId !== null && !Number.isInteger(teamId)) return redirect(`${back}?err=bad_input`, 303);

  try {
    await addManualParticipant(
      env.DB,
      id,
      String(form.get('name') ?? ''),
      status,
      teamId,
      Math.floor(Date.now() / 1000),
    );
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
  return redirect(back, 303);
};
