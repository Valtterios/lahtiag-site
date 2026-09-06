import { describe, it, expect } from 'vitest';
import { countsLine, announcementComponents } from '../src/lib/announce';

// What the announcement carries: counts and buttons by the event's state.

describe('announcement', () => {
  it('counts going, maybe and interest, teams for team events', () => {
    expect(countsLine({ yes_count: 12, maybe_count: 2, interest_count: 5, team_size: null, teams_count: 0, capacity: 20 })).toBe('👥 12 / 20 going · 2 maybe · ♡ 5 interested');
    expect(countsLine({ yes_count: 9, maybe_count: 0, interest_count: 0, team_size: 3, teams_count: 3, capacity: null })).toBe('👥 3 teams, 9 players');
  });

  it('offers signup buttons on a plain event, a ticket link on a ticketed one, none when cancelled', () => {
    const plain = announcementComponents({ id: 1, cancelled_at: null, signups_closed_at: null }, false, 'https://x') as { components: { label: string; custom_id?: string; url?: string }[] }[];
    expect(plain[0].components.map((b) => b.label)).toEqual(["I'm going", 'Maybe', 'Interested', 'Details']);
    expect(plain[0].components[0].custom_id).toBe('e:go:1');
    const ticketed = announcementComponents({ id: 2, cancelled_at: null, signups_closed_at: null }, true, 'https://x') as { components: { label: string; url?: string }[] }[];
    expect(ticketed[0].components.map((b) => b.label)).toEqual(['Tickets', 'Interested']);
    expect(ticketed[0].components[0].url).toBe('https://x/events/2');
    const closed = announcementComponents({ id: 3, cancelled_at: null, signups_closed_at: 5 }, false, 'https://x') as { components: { label: string }[] }[];
    expect(closed[0].components.map((b) => b.label)).toEqual(['Interested', 'Details']);
    expect(announcementComponents({ id: 4, cancelled_at: 1, signups_closed_at: null }, false, 'https://x')).toEqual([]);
  });
});
