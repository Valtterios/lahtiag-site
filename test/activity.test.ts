import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  parseActivityBatch,
  applyActivityBatch,
  pruneActivityBatches,
  seasonMonths,
  seasonDays,
  seasonStartYear,
  seasonLabel,
  seasonActivity,
  monthlyActivity,
  channelSeason,
  helsinkiDay,
  voiceLabel,
} from '../src/lib/activity';

const SEP = Date.UTC(2026, 8, 6, 12) / 1000; // Sunday 6 September 2026, 15:00 Helsinki
const ID = '100000000000000001';

describe('Discord activity batches', () => {
  it('accepts a well-formed batch and refuses the rest', () => {
    expect(parseActivityBatch(null)).toBeNull();
    expect(parseActivityBatch({ instance: 'a', seq: 0, deltas: [] })).toBeNull();
    expect(parseActivityBatch({ instance: 'a b', seq: 1, deltas: [] })).toBeNull();
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [{ discord_id: '12', day: '2026-09-06', messages: 1 }] })).toBeNull();
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [{ discord_id: ID, day: '2026-09', messages: 1 }] })).toBeNull();
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [{ discord_id: ID, day: '2026-09-32', messages: 1 }] })).toBeNull();
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [{ discord_id: ID, day: '2026-09-06', messages: -1 }] })).toBeNull();
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [{ discord_id: ID, day: '2026-09-06', messages: 1.5 }] })).toBeNull();
    const ok = parseActivityBatch({
      instance: 'listener-1',
      seq: 3,
      deltas: [
        { discord_id: ID, day: '2026-09-06', messages: 3 },
        { discord_id: '100000000000000002', day: '2026-09-06', messages: 0, voice_minutes: 0 },
      ],
      channel_deltas: [{ channel_id: '100000000000000005', name: 'general', day: '2026-09-06', messages: 3 }],
    });
    expect(ok).toEqual({
      instance: 'listener-1',
      seq: 3,
      deltas: [{ discord_id: ID, day: '2026-09-06', messages: 3, voice_minutes: 0 }],
      channel_deltas: [{ channel_id: '100000000000000005', name: 'general', day: '2026-09-06', messages: 3, voice_minutes: 0 }],
    });
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [], channel_deltas: [{ channel_id: '100000000000000005', name: '', day: '2026-09-06', messages: 3 }] })).toBeNull();
  });

  it('applies a batch once and adds the season up', async () => {
    const first = {
      instance: 'listener-a',
      seq: 1,
      deltas: [{ discord_id: ID, day: '2026-09-02', messages: 40, voice_minutes: 30 }],
      channel_deltas: [{ channel_id: '100000000000000005', name: 'general', day: '2026-09-02', messages: 40, voice_minutes: 0 }],
    };
    expect(await applyActivityBatch(env.DB, first, SEP)).toEqual({ applied: 2, duplicate: false });
    expect(await applyActivityBatch(env.DB, first, SEP)).toEqual({ applied: 0, duplicate: true });
    await applyActivityBatch(
      env.DB,
      {
        instance: 'listener-a',
        seq: 2,
        deltas: [
          { discord_id: ID, day: '2026-09-06', messages: 12, voice_minutes: 0 },
          { discord_id: ID, day: '2026-08-31', messages: 99, voice_minutes: 99 }, // last season
        ],
        channel_deltas: [
          { channel_id: '100000000000000005', name: 'general', day: '2026-09-06', messages: 12, voice_minutes: 0 },
          { channel_id: '100000000000000006', name: 'Gaming', day: '2026-09-06', messages: 0, voice_minutes: 30 },
        ],
      },
      SEP,
    );
    expect(await seasonActivity(env.DB, ID, SEP)).toEqual({ messages: 52, voice_minutes: 30 });
    expect(await monthlyActivity(env.DB, ID, SEP)).toEqual([{ month: '2026-09', messages: 52, voice_minutes: 30 }]);
    expect(await channelSeason(env.DB, SEP)).toEqual([
      { channel_id: '100000000000000005', name: 'general', messages: 52, voice_minutes: 0, days: 2 },
      { channel_id: '100000000000000006', name: 'Gaming', messages: 0, voice_minutes: 30, days: 1 },
    ]);
    expect(await seasonActivity(env.DB, '100000000000000009', SEP)).toEqual({ messages: 0, voice_minutes: 0 });
    expect(await pruneActivityBatches(env.DB, SEP + 1)).toBe(2);
  });

  it('knows the academic year', () => {
    expect(seasonStartYear(SEP)).toBe(2026);
    expect(seasonStartYear(Date.UTC(2027, 0, 15) / 1000)).toBe(2026);
    expect(seasonStartYear(Date.UTC(2026, 7, 31, 20) / 1000)).toBe(2025); // 31 Aug 23:00 Helsinki
    expect(seasonStartYear(Date.UTC(2026, 7, 31, 21) / 1000)).toBe(2026); // 1 Sept 00:00 Helsinki
    expect(seasonLabel(SEP)).toBe('2026–27');
    expect(seasonMonths(SEP)).toEqual(['2026-09']);
    expect(helsinkiDay(Date.UTC(2026, 7, 31, 21) / 1000)).toBe('2026-09-01');
    expect(seasonDays(SEP)).toEqual({ from: '2026-09-01', to: '2026-09-06' });
    expect(seasonMonths(Date.UTC(2027, 0, 15) / 1000)).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    expect(voiceLabel(45)).toBe('45 min');
    expect(voiceLabel(60)).toBe('1 h');
    expect(voiceLabel(135)).toBe('2 h 15 min');
  });
});

describe('the counted channels', () => {
  it('travel with a batch and are remembered', async () => {
    const { parseActivityBatch, rememberActivityChannels, activityChannels } = await import('../src/lib/activity');
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [], channels: [{ id: '100000000000000001', name: 'general', kind: 'chat' }] })).toBeNull();
    expect(parseActivityBatch({ instance: 'a', seq: 1, deltas: [], channels: [{ id: 'x', name: 'general', kind: 'text' }] })).toBeNull();
    const batch = parseActivityBatch({
      instance: 'a',
      seq: 1,
      deltas: [],
      channels: [
        { id: '100000000000000001', name: 'general', kind: 'text' },
        { id: '100000000000000002', name: 'Gaming', kind: 'voice' },
      ],
    });
    expect(batch?.channels).toHaveLength(2);
    expect(await activityChannels(env.DB)).toEqual([]);
    expect(await rememberActivityChannels(env.DB, batch!.channels!, 1)).toBe(true);
    expect(await rememberActivityChannels(env.DB, batch!.channels!, 2)).toBe(false); // unchanged, nothing written
    expect(await activityChannels(env.DB)).toEqual(batch!.channels);
  });
});
