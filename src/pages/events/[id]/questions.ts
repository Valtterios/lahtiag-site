import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { createEventQuestion, updateEventQuestion, deleteEventQuestion, RuleError } from '../../../lib/db';
import { QUESTION_KINDS, type QuestionKind } from '../../../lib/questions';

// The board's questions on an event: action = create | update | delete.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  if (!Number.isInteger(id)) return redirect('/events?err=missing', 303);

  const action = String(form.get('action') ?? '');
  const questionId = Number(form.get('question_id'));
  const kindRaw = String(form.get('kind') ?? 'text');
  const kind = QUESTION_KINDS.find((k): k is QuestionKind => k === kindRaw) ?? 'text';
  const input = {
    label: String(form.get('label') ?? ''),
    kind,
    options: String(form.get('options') ?? '').replace(/\r/g, '').trim() || null,
    required: form.get('required') === 'on',
  };
  try {
    if (action === 'create') await createEventQuestion(env.DB, id, input);
    else if (action === 'update' && Number.isInteger(questionId)) await updateEventQuestion(env.DB, questionId, input);
    else if (action === 'delete' && Number.isInteger(questionId)) await deleteEventQuestion(env.DB, questionId);
    else return redirect(`${back}?err=bad_input`, 303);
    return redirect(`${back}?ok=question_saved#questions`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
