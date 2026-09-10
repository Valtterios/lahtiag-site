import { describe, it, expect } from 'vitest';
import { kindTerms, waysLines, collectedLines, xpGuideLines } from '../src/lib/xp-guide';
import { passProgress } from '../src/lib/pass';
import type { TickKind } from '../src/lib/ticks';

// The /xp answer, as pure text.

const kind = (over: Partial<TickKind>): TickKind => ({ id: 1, name: 'Helped at an event', description: null, sort: 1, xp: 100, season_cap: 1, period: 'season', claimable: true, auto_source: null, auto_step: 0, retired_at: null, given: 0, ...over });
const NOW = Date.UTC(2026, 8, 7, 12) / 1000;

describe('the XP guide', () => {
  it('says what a tick pays and how many count', () => {
    expect(kindTerms(kind({}))).toBe('100 XP, up to 1 per season');
    expect(kindTerms(kind({ xp: 30, season_cap: 0 }))).toBe('30 XP, every one counts');
    expect(kindTerms(kind({ xp: 10, season_cap: 2, period: 'week' }))).toBe('10 XP, up to 2 per week');
    expect(kindTerms(kind({ xp: 20, season_cap: 10, period: 'week', auto_source: 'minecraft', auto_step: 60 }))).toBe('20 XP per 1 h on Minecraft, up to 10 per week');
    expect(kindTerms(kind({ xp: 15, season_cap: 0, auto_source: 'events', auto_step: 1 }))).toBe('15 XP per event attended, every one counts');
    expect(waysLines([kind({ xp: 5, season_cap: 0, auto_source: 'messages', auto_step: 50, claimable: true })])[0]).toBe('• **Helped at an event** · 5 XP per 50 messages, every one counts');
    const lines = waysLines([kind({}), kind({ id: 2, name: 'Brought gear', xp: 30, season_cap: 0, claimable: false, description: 'A controller, a cable, a screen.' }), kind({ id: 3, name: 'Old', retired_at: 1 }), kind({ id: 4, name: 'Free', xp: 0 })]);
    expect(lines).toEqual([
      '• **Helped at an event** · 100 XP, up to 1 per season · claimable',
      '• **Brought gear** · 30 XP, every one counts\n-# A controller, a cable, a screen.',
    ]);
    expect(waysLines([])).toEqual(['The board has not put any XP on the list yet.']);
    // A kind already held drops out of the how-to.
    const held = { kind_id: 1, kind: 'Helped at an event', event: null, given_at: NOW, xp: 100, season_cap: 1, period: 'season' as const };
    expect(waysLines([kind({}), kind({ id: 2, name: 'Brought gear', xp: 30, season_cap: 0, claimable: false })], [held])).toEqual(['• **Brought gear** · 30 XP, every one counts']);
    expect(waysLines([kind({})], [held])[0]).toContain('every kind on the list');
  });

  it('lists what was collected by kind, with the terms and the over-cap count', () => {
    const t = { kind_id: 1, kind: 'Helped at an event', event: null as string | null, xp: 100, season_cap: 1, period: 'season' as const };
    expect(collectedLines([])).toEqual(['Nothing yet. The first tick starts it.']);
    expect(collectedLines([{ ...t, given_at: NOW, event: 'Autumn LAN' }, { ...t, given_at: NOW + 60 }], [kind({})])).toEqual([
      '✅ **Helped at an event** · **100 XP** from 1 (+1 over the cap) · 100 XP, up to 1 per season · Autumn LAN',
    ]);
    const chat = { kind_id: 2, kind: 'Chatted', event: null, xp: 5, season_cap: 0, period: 'season' as const };
    expect(collectedLines([{ ...chat, given_at: NOW }, { ...chat, given_at: NOW + 60 }])).toEqual(['✅ **Chatted** · **10 XP** from 2 · 5 XP, every one counts · 7 Sept 2026']);
    expect(collectedLines([{ ...t, given_at: NOW }])).toEqual(['✅ **Helped at an event** · **100 XP** · 100 XP, up to 1 per season · 7 Sept 2026']);
  });

  it('puts it together', () => {
    const summary = { label: '2026–27', events: 2, messages: 40, voice_minutes: 90, playtime: [], minecraft_name: null, ticks: [], tick_xp: 0, claims_pending: 1, pass: passProgress(0, []), held: [] };
    const text = xpGuideLines([kind({})], summary);
    expect(text).toContain('## ✨ How to earn XP');
    expect(text).toContain('-# Events (2 attended), Discord (40 messages, 1 h 30 min in voice) and Minecraft are counted');
    expect(text).toContain('## 🎫 Collected this season · 0 XP');
    expect(text).toContain('⏳ 1 claim waiting for the board');
    expect(text).toContain('-# /claim asks the board for a tick · /pass shows the levels');
    expect(text).not.toContain('http');
  });
});
