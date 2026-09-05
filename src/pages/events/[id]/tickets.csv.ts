import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/guard';
import { requireBoard } from '../../../lib/board';
import { getEvent, listEventTickets, listEventQuestions, listAllAnswers } from '../../../lib/db';
import { csvCell } from '../../../lib/register';
import { formatHelsinki } from '../../../lib/time';

// Every ticket of an event, for the treasurer: who, what, how much, when,
// paid or refunded, checked in or not. Board role or register access.

export const GET: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const board = await requireBoard(request, env);
  const admin = board.ok ? null : await requireAdmin(request, env);
  if (!board.ok && !admin?.ok) return redirect(`/events/${id}?err=forbidden`, 303);
  const event = Number.isInteger(id) ? await getEvent(env.DB, id) : null;
  if (!event) return redirect('/events?err=missing', 303);

  const rows = await listEventTickets(env.DB, id);
  const questions = await listEventQuestions(env.DB, id);
  const answers = await listAllAnswers(env.DB, id);
  const lines = [['code','holder','type','amount_eur','status','source','created','paid','checked_in','discord_id','payment_intent', ...questions.map((q) => q.label)].map(csvCell).join(',')];
  for (const t of rows) {
    const mine = t.discord_id ? answers.get(`u:${t.discord_id}`) : answers.get(`t:${t.id}`);
    lines.push(
      [
        t.code,
        t.holder_name,
        t.type_name,
        (t.amount_cents / 100).toFixed(2),
        t.status,
        t.source,
        formatHelsinki(t.created_at),
        t.paid_at === null ? null : formatHelsinki(t.paid_at),
        t.checked_in_at === null ? null : formatHelsinki(t.checked_in_at),
        t.discord_id,
        t.stripe_payment_intent,
        ...questions.map((q) => mine?.get(q.id) ?? ''),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const slug = event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tickets-${slug}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
