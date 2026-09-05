import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMember,
  createEvent,
  createTicketType,
  createTicket,
  createEventQuestion,
  updateEventQuestion,
  deleteEventQuestion,
  listEventQuestions,
  saveAnswers,
  getAnswers,
  listAllAnswers,
  deleteEvent,
} from '../src/lib/db';
import { parseAnswers, answersComplete, questionOptions } from '../src/lib/questions';

const NOW = 1_760_000_000;
const db = () => env.DB;

beforeEach(async () => {
  for (const table of ['signup_answers', 'event_questions', 'tickets', 'ticket_types', 'signups', 'events', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
});

async function event(): Promise<number> {
  await upsertMember(db(), { discord_id: 'admin', username: 'admin', avatar_hash: null }, NOW);
  return createEvent(db(), { title: 'LAN', description: null, starts_at: NOW + 86400, capacity: null, created_by: 'admin' }, NOW);
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe('event questions', () => {
  it('validates the board side: labels, choice options, the limit', async () => {
    const id = await event();
    await expect(createEventQuestion(db(), id, { label: '', kind: 'text', options: null, required: false })).rejects.toMatchObject({ code: 'bad_input' });
    await expect(createEventQuestion(db(), id, { label: 'Size', kind: 'choice', options: 'M', required: false })).rejects.toMatchObject({ code: 'bad_input' });
    const q1 = await createEventQuestion(db(), id, { label: 'In-game name', kind: 'text', options: null, required: true });
    const q2 = await createEventQuestion(db(), id, { label: 'Size', kind: 'choice', options: 'S\nM\nL', required: false });
    await updateEventQuestion(db(), q2, { label: 'Shirt size', kind: 'choice', options: 'S\nM\nL\nXL', required: true });
    const list = await listEventQuestions(db(), id);
    expect(list.map((q) => [q.id, q.label, q.required])).toEqual([[q1, 'In-game name', 1], [q2, 'Shirt size', 1]]);
    expect(questionOptions(list[1])).toEqual(['S', 'M', 'L', 'XL']);
    for (let i = 0; i < 6; i++) await createEventQuestion(db(), id, { label: `Q${i}`, kind: 'checkbox', options: null, required: false });
    await expect(createEventQuestion(db(), id, { label: 'One too many', kind: 'text', options: null, required: false })).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('parses and checks answers, stores them per person or per ticket, and cleans up with the event', async () => {
    const id = await event();
    const q1 = await createEventQuestion(db(), id, { label: 'Name in game', kind: 'text', options: null, required: true });
    const q2 = await createEventQuestion(db(), id, { label: 'Size', kind: 'choice', options: 'S\nM', required: false });
    const q3 = await createEventQuestion(db(), id, { label: 'Vegan', kind: 'checkbox', options: null, required: false });
    const questions = await listEventQuestions(db(), id);

    const bad = parseAnswers(questions, form({ [`q${q1}`]: '  ', [`q${q2}`]: 'XL' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => [e.question.id, e.problem])).toEqual([[q1, 'required'], [q2, 'invalid']]);

    const good = parseAnswers(questions, form({ [`q${q1}`]: '  Aino   V ', [`q${q2}`]: 'M', [`q${q3}`]: 'on' }));
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect([...good.answers.entries()]).toEqual([[q1, 'Aino V'], [q2, 'M'], [q3, 'yes']]);
    expect(answersComplete(questions, good.answers)).toBe(true);
    expect(answersComplete(questions, new Map())).toBe(false);

    await saveAnswers(db(), id, { discordId: 'u1' }, good.answers, NOW);
    await saveAnswers(db(), id, { discordId: 'u1' }, new Map([[q2, 'S']]), NOW + 1); // update one
    const typeId = await createTicketType(db(), id, { name: 'Door', price_cents: 0, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    const walkIn = await createTicket(db(), { event_id: id, ticket_type_id: typeId, discord_id: null, holder_name: 'Walk In', amount_cents: 0, status: 'paid', source: 'door' }, NOW);
    await saveAnswers(db(), id, { ticketId: walkIn.id }, new Map([[q1, 'Walk In']]), NOW);
    expect([...(await getAnswers(db(), id, { discordId: 'u1' })).entries()]).toEqual([[q1, 'Aino V'], [q2, 'S'], [q3, 'yes']]);
    const all = await listAllAnswers(db(), id);
    expect(all.get(`t:${walkIn.id}`)?.get(q1)).toBe('Walk In');
    await deleteEventQuestion(db(), q3);
    expect((await getAnswers(db(), id, { discordId: 'u1' })).has(q3)).toBe(false);
    await deleteEvent(db(), id);
    expect(await listEventQuestions(db(), id)).toEqual([]);
    expect((await listAllAnswers(db(), id)).size).toBe(0);
  });
});
