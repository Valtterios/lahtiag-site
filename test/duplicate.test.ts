import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setSignup, createTicketType, createEventQuestion, setEventCover, getEventCover, duplicateEvent, getEvent, listTicketTypes, listEventQuestions } from '../src/lib/db';

// A copy of an event: the setup, not the people.

const NOW = 1_760_000_000;
const db = () => env.DB;
// The smallest valid PNG: 1x1, so the cover has real dimensions.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

describe('duplicateEvent', () => {
  beforeEach(async () => {
    for (const table of ['event_covers', 'event_questions', 'ticket_types', 'signups', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
    await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
  });

  it('copies details, active ticket types without deadlines, questions and the cover into a draft a week later', async () => {
    const id = await createEvent(db(), { title: 'LAN', description: 'Fun', starts_at: NOW + 86400, ends_at: NOW + 90000, capacity: 20, team_size: 5, organizers: 'LahtiAG', location: 'Hall', link_url: 'https://x', members_only: false, member_slots: null, created_by: 'host' }, NOW);
    await setSignup(db(), id, 'host', 'yes', NOW);
    await createTicketType(db(), id, { name: 'Entry', price_cents: 500, member_price_cents: 300, members_only: false, quantity: 10, sales_close_at: NOW + 3600, description: 'All night' });
    const retired = await createTicketType(db(), id, { name: 'Old', price_cents: 100, member_price_cents: null, members_only: false, quantity: null, sales_close_at: null });
    await db().prepare('UPDATE ticket_types SET active = 0 WHERE id = ?1').bind(retired).run();
    await createEventQuestion(db(), id, { label: 'Shirt', kind: 'choice', options: 'S\nM\nL', required: true });
    await setEventCover(db(), id, 'image/png', PNG.buffer.slice(0), NOW);

    const copy = await duplicateEvent(db(), id, 'host', NOW + 10);
    const event = (await getEvent(db(), copy))!;
    expect(event.title).toBe('LAN (copy)');
    expect(event.published_at).toBeNull();
    expect(event.starts_at).toBe(NOW + 86400 + 7 * 86400);
    expect(event.ends_at).toBe(NOW + 90000 + 7 * 86400);
    expect(event).toMatchObject({ capacity: 20, team_size: 5, organizers: 'LahtiAG', location: 'Hall', members_only: 0, link_url: 'https://x', yes_count: 0 });
    const types = await listTicketTypes(db(), copy);
    expect(types.map((t) => [t.name, t.price_cents, t.member_price_cents, t.quantity, t.sales_close_at, t.description])).toEqual([['Entry', 500, 300, 10, null, 'All night']]);
    expect((await listEventQuestions(db(), copy)).map((q) => [q.label, q.kind, q.required])).toEqual([['Shirt', 'choice', 1]]);
    expect((await getEventCover(db(), copy))?.bytes.byteLength).toBe(PNG.length);
    await expect(duplicateEvent(db(), 999, 'host', NOW)).rejects.toMatchObject({ code: 'missing' });
  });
});
