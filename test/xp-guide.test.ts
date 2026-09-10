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
  });

  it('lists what was collected, over-cap ticks marked', () => {
    const t = { kind_id: 1, kind: 'Helped at an event', event: null as string | null, xp: 100, season_cap: 1, period: 'season' as const };
    expect(collectedLines([])).toEqual(['Nothing yet. The first tick starts it.']);
    expect(collectedLines([{ ...t, given_at: NOW, event: 'Autumn LAN' }, { ...t, given_at: NOW + 60 }])).toEqual([
      '✅ Helped at an event (Autumn LAN) · **100 XP** · 7 Sept 2026',
      '▫️ Helped at an event · over the cap · 7 Sept 2026',
    ]);
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
