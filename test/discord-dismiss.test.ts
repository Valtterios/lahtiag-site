import { describe, it, expect, vi } from 'vitest';
import { dismissDelay, dismissReply, DISMISS_AFTER_MS, DISMISS_FLOOR_MS } from '../src/lib/discord';

// Errors and confirmations clear themselves; Discord has no timer, so the
// bot deletes its own reply through the interaction token.
describe('self-clearing replies', () => {
  it('goes 25 s after the interaction arrived, never sooner than 10 s after the reply', () => {
    const arrived = 1_000_000;
    expect(dismissDelay(arrived, arrived)).toBe(DISMISS_AFTER_MS);
    expect(dismissDelay(arrived, arrived + 5_000)).toBe(DISMISS_AFTER_MS - 5_000);
    expect(dismissDelay(arrived, arrived + 20_000)).toBe(DISMISS_FLOOR_MS);
    expect(dismissDelay(arrived, arrived + 60_000)).toBe(DISMISS_FLOOR_MS);
  });

  it('deletes the original reply through the interaction token, after waiting', async () => {
    const calls: { url: string; method?: string }[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 204 });
    });
    const waits: number[] = [];
    try {
      await dismissReply('app1', 'tok1', Date.now(), async (ms) => {
        waits.push(ms);
      });
    } finally {
      spy.mockRestore();
    }
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(DISMISS_FLOOR_MS);
    expect(waits[0]).toBeLessThanOrEqual(DISMISS_AFTER_MS);
    expect(calls).toEqual([{ url: 'https://discord.com/api/v10/webhooks/app1/tok1/messages/@original', method: 'DELETE' }]);
  });

  it('swallows a failed delete: the reply just stays', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      await expect(dismissReply('app1', 'tok1', Date.now(), async () => {})).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
