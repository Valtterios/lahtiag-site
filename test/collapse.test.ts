import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { scheduleCollapse, listDueCollapses, collapseDue, COLLAPSE_AFTER } from '../src/lib/collapse';

// Cards folding to a line: noted at posting, folded by the cron once due.

const NOW = 1_760_000_000;

describe('collapsing messages', () => {
  it('folds a message once its minute is up, forgets a deleted one, retries the rest', async () => {
    await scheduleCollapse(env.DB, { id: 'm1', channel_id: 'c1' }, "🎫 **Aino**'s battle pass was here", NOW);
    await scheduleCollapse(env.DB, { id: 'm2', channel_id: 'c1' }, 'gone', NOW);
    await scheduleCollapse(env.DB, { id: 'm3', channel_id: 'c1' }, 'flaky', NOW);
    await scheduleCollapse(env.DB, { id: 'm4', channel_id: 'c1' }, 'later', NOW + 300);
    expect((await listDueCollapses(env.DB, NOW + COLLAPSE_AFTER)).map((m) => m.message_id)).toEqual(['m1', 'm2', 'm3']);
    expect(await listDueCollapses(env.DB, NOW + 10)).toEqual([]);
    // Without the bot nothing can be folded, and nothing is lost.
    expect(await collapseDue(env.DB, {}, NOW + 100)).toBe(0);

    const edits: { url: string; body: Record<string, unknown> }[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      edits.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith('/messages/m2')) return new Response('{}', { status: 404 });
      if (url.endsWith('/messages/m3')) return new Response('{}', { status: 500 });
      return new Response('{"id":"m1"}', { status: 200 });
    });
    try {
      expect(await collapseDue(env.DB, { DISCORD_BOT_TOKEN: 't' }, NOW + 100)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const m1 = edits.find((e) => e.url.endsWith('/messages/m1'))!;
    expect(m1.body).toMatchObject({ content: "🎫 **Aino**'s battle pass was here", attachments: [], components: [] });
    // m1 folded and m2 forgotten; m3 waits for the next run; m4 is not due.
    expect((await listDueCollapses(env.DB, NOW + 1000)).map((m) => m.message_id)).toEqual(['m3', 'm4']);
  });
});
