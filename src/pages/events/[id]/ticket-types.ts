import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import { createTicketType, updateTicketType, deleteTicketType, RuleError } from '../../../lib/db';
import { helsinkiToUnix } from '../../../lib/time';

// The board manages an event's ticket types from the event page:
// action = create | update | delete, prices typed in euros.

function euros(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (text === '') return null;
  const value = Math.round(Number(text) * 100);
  return Number.isFinite(value) ? value : NaN;
}

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const back = `/events/${id}`;
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}?err=${admin.reason}`, 303);
  const form = await request.formData();
  if (!(await checkCsrf(request, form))) return redirect(`${back}?err=csrf`, 303);
  if (!Number.isInteger(id)) return redirect('/events?err=missing', 303);

  const action = String(form.get('action') ?? '');
  const typeId = Number(form.get('ticket_type_id'));
  try {
    if (action === 'delete') {
      if (!Number.isInteger(typeId)) return redirect(`${back}?err=bad_input`, 303);
      await deleteTicketType(env.DB, typeId);
      return redirect(`${back}?ok=type_deleted#tickets`, 303);
    }
    const price = euros(form.get('price'));
    const memberPrice = euros(form.get('member_price'));
    if (price === null || Number.isNaN(price) || Number.isNaN(memberPrice)) return redirect(`${back}?err=bad_input`, 303);
    const quantityRaw = String(form.get('quantity') ?? '').trim();
    const quantity = quantityRaw ? Number(quantityRaw) : null;
    const closeDate = String(form.get('close_date') ?? '').trim();
    const closeTime = String(form.get('close_time') ?? '').trim() || '23:59';
    let salesClose: number | null = null;
    if (closeDate) {
      salesClose = helsinkiToUnix(closeDate, closeTime);
      if (salesClose === null) return redirect(`${back}?err=bad_time`, 303);
    }
    const input = {
      name: String(form.get('name') ?? ''),
      price_cents: price,
      member_price_cents: memberPrice,
      members_only: form.get('members_only') === 'on',
      quantity,
      sales_close_at: salesClose,
      description: String(form.get('description') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
    if (action === 'create') {
      await createTicketType(env.DB, id, input);
      return redirect(`${back}?ok=type_saved#tickets`, 303);
    }
    if (action === 'update') {
      if (!Number.isInteger(typeId)) return redirect(`${back}?err=bad_input`, 303);
      await updateTicketType(env.DB, typeId, { ...input, active: form.get('active') === 'on' });
      return redirect(`${back}?ok=type_saved#tickets`, 303);
    }
    return redirect(`${back}?err=bad_input`, 303);
  } catch (error) {
    if (error instanceof RuleError) return redirect(`${back}?err=${error.code}`, 303);
    throw error;
  }
};
