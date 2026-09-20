import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { checkCsrf, requireAdmin } from '../../../lib/guard';
import {
  RuleError,
  getBracket,
  getBracketRow,
  getEvent,
  listEventTeams,
  listSignups,
} from '../../../lib/db';
import { cancelCS2Match, sendMatchToServer } from '../../../lib/cs2';

// The board putting a bracket match onto a Counter-Strike server, and taking
// it off again.
//
// "Off again" only stops the site listening. It does not touch the server:
// ending a match that ten people are playing is a decision for whoever is
// standing in the room, and automation reaching into a live game on a timer
// is the exact mistake that wiped two of them.

export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  const form = await request.formData();
  const bracketId = Number(form.get('bracket'));
  const back = `/events/${id}/bracket${Number.isInteger(bracketId) ? `?b=${bracketId}` : ''}`;

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return redirect(`${back}${back.includes('?') ? '&' : '?'}err=${admin.reason}`, 303);
  if (!(await checkCsrf(request, form))) return redirect(`${back}&err=csrf`, 303);

  const fail = (code: string) => redirect(`${back}${back.includes('?') ? '&' : '?'}err=${code}`, 303);
  const done = (code: string) => redirect(`${back}${back.includes('?') ? '&' : '?'}ok=${code}`, 303);

  try {
    if (form.get('action') === 'cancel') {
      await cancelCS2Match(env.DB, Number(form.get('match')), Math.floor(Date.now() / 1000));
      return done('cs2_cancelled');
    }

    const event = await getEvent(env.DB, id);
    const bracket = await getBracketRow(env.DB, bracketId);
    if (!event || !bracket || bracket.event_id !== id) return fail('missing');

    const round = Number(form.get('round'));
    const slot = Number(form.get('slot'));
    const matches = await getBracket(env.DB, bracket.id);
    const match = matches.find((m) => m.round === round && m.slot === slot);
    if (!match) return fail('missing');
    const totalRounds = matches.reduce((max, m) => Math.max(max, m.round), 0);

    // The scoreboard names, frozen into the row: what the server shows the
    // players, and what it reports back about.
    const names = new Map<string, string>();
    for (const signup of await listSignups(env.DB, id)) names.set(`u:${signup.discord_id}`, signup.username);
    if (event.team_size !== null) {
      for (const team of await listEventTeams(env.DB, id)) names.set(`t:${team.id}`, team.name);
    }
    const nameA = names.get(match.side_a ?? '');
    const nameB = names.get(match.side_b ?? '');
    if (!nameA || !nameB) return fail('bad_input');

    await sendMatchToServer(
      env.DB,
      bracket,
      match,
      totalRounds,
      String(form.get('server') ?? ''),
      { a: nameA, b: nameB },
      Math.floor(Date.now() / 1000),
    );
    return done('cs2_sent');
  } catch (error) {
    if (error instanceof RuleError) return fail(error.code);
    throw error;
  }
};
