import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/guard';
import { requireBoard } from '../../../lib/board';
import { getEvent, listSignups, listEventTeams, listEventQuestions, listAllAnswers } from '../../../lib/db';
import { csvCell } from '../../../lib/register';

// The roster with everyone's answers, for the organisers of a free event.
// Board role or register access.

export const GET: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const board = await requireBoard(request, env);
  const admin = board.ok ? null : await requireAdmin(request, env);
  if (!board.ok && !admin?.ok) return redirect(`/events/${id}?err=forbidden`, 303);
  const event = Number.isInteger(id) ? await getEvent(env.DB, id) : null;
  if (!event) return redirect('/events?err=missing', 303);

  const [signups, teams, questions, answers] = await Promise.all([
    listSignups(env.DB, id),
    listEventTeams(env.DB, id),
    listEventQuestions(env.DB, id),
    listAllAnswers(env.DB, id),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const lines = [['name', 'status', 'team', 'member', ...questions.map((q) => q.label)].map(csvCell).join(',')];
  for (const s of signups) {
    const mine = answers.get(`u:${s.discord_id}`);
    lines.push(
      [
        s.username,
        s.status,
        s.event_team_id === null ? null : (teamName.get(s.event_team_id) ?? ''),
        s.is_member === 1 ? 'yes' : 'no',
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
      'content-disposition': `attachment; filename="roster-${slug}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
