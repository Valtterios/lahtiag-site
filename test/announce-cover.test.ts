import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setEventMessageId, setEventCover, setSetting } from '../src/lib/db';
import { replaceAnnouncementCover } from '../src/lib/announce';

// A new cover on a published event reaches the announcement. The bot posts
// it, so the bot has to edit it: the webhook's PATCH cannot touch another
// author's message, and the picture used to stay the old one.

const NOW = 1_760_000_000;
const db = () => env.DB;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const WEBHOOK = 'https://discord.com/api/webhooks/1/tok';

async function seed(): Promise<number> {
  for (const table of ['event_covers', 'events', 'members', 'settings']) await db().prepare(`DELETE FROM ${table}`).run();
  await upsertMember(db(), { discord_id: '100', username: 'board', avatar_hash: null }, NOW);
  const id = await createEvent(db(), { title: 'Autumn LAN', description: null, starts_at: NOW + 86400, capacity: null, created_by: '100' }, NOW);
  await setEventMessageId(db(), id, '555');
  await setEventCover(db(), id, 'image/png', PNG.buffer as ArrayBuffer, NOW);
  await setSetting(db(), 'announce_channel_id', '777', 'bot', NOW);
  return id;
}

// Records where the swap was sent, and answers the way Discord would.
function recorder(ok: boolean) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(ok ? JSON.stringify({ id: '555' }) : 'no', { status: ok ? 200 : 403 });
  });
  return calls;
}

describe('the announcement cover', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => vi.unstubAllGlobals());

  it('is swapped on the bot’s own message', async () => {
    const id = await seed();
    const calls = recorder(true);
    await replaceAnnouncementCover(db(), { DISCORD_BOT_TOKEN: 'tok', DISCORD_WEBHOOK_URL: WEBHOOK }, id, 'https://x');
    expect(calls).toEqual(['PATCH https://discord.com/api/v10/channels/777/messages/555']);
  });

  it('falls back to the webhook when the bot cannot edit it', async () => {
    const id = await seed();
    const calls = recorder(false);
    await replaceAnnouncementCover(db(), { DISCORD_BOT_TOKEN: 'tok', DISCORD_WEBHOOK_URL: WEBHOOK }, id, 'https://x');
    expect(calls).toEqual([
      'PATCH https://discord.com/api/v10/channels/777/messages/555',
      `PATCH ${WEBHOOK}/messages/555`,
    ]);
  });

  it('does nothing without a message to edit', async () => {
    const id = await seed();
    await db().prepare('UPDATE events SET discord_message_id = NULL WHERE id = ?1').bind(id).run();
    const calls = recorder(true);
    await replaceAnnouncementCover(db(), { DISCORD_BOT_TOKEN: 'tok', DISCORD_WEBHOOK_URL: WEBHOOK }, id, 'https://x');
    expect(calls).toEqual([]);
  });
});
