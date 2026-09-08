import { describe, it, expect } from 'vitest';
import { countsLine, announcementComponents, announcementText } from '../src/lib/announce';
import { pingMentions } from '../src/lib/news';
import type { EventWithCounts } from '../src/lib/db';

// What the announcement carries: counts and buttons by the event's state.

describe('announcement', () => {
  it('counts going, maybe and interest, teams for team events', () => {
    expect(countsLine({ yes_count: 12, maybe_count: 2, interest_count: 5, team_size: null, teams_count: 0, capacity: 20 })).toBe('👥 12 / 20 going · 2 maybe · ♡ 5 interested');
    expect(countsLine({ yes_count: 9, maybe_count: 0, interest_count: 0, team_size: 3, teams_count: 3, capacity: null })).toBe('👥 3 teams, 9 players');
  });

  it('leads with the ping it was published with, and with nothing when it pings nobody', () => {
    const base = { id: 7, title: 'LAN', starts_at: 1_760_000_000, ends_at: null, organizers: null, team_size: null, teams_count: 0, yes_count: 0, maybe_count: 0, interest_count: 0, capacity: null } as unknown as EventWithCounts;
    expect(announcementText({ ...base, ping: null }, 'https://x')).toMatch(/^📅 \*\*LAN\*\*/);
    expect(announcementText({ ...base, ping: 'everyone' }, 'https://x')).toMatch(/^@everyone 📅/);
    expect(announcementText({ ...base, ping: '1234567890123456789' }, 'https://x')).toMatch(/^<@&1234567890123456789> 📅/);
    // …and the mention is allowed through only for the one it names.
    expect(pingMentions('1234567890123456789')).toEqual({ parse: [], roles: ['1234567890123456789'] });
    expect(pingMentions(null)).toEqual({ parse: [] });
  });

  it('reads like a news post: the place, the words, then the way in', () => {
    const base = { id: 7, title: 'LAN', starts_at: 1_760_000_000, ends_at: null, organizers: null, team_size: null, teams_count: 0, yes_count: 0, maybe_count: 0, interest_count: 0, capacity: null, ping: null, location: 'Mukkulankatu 19' } as unknown as EventWithCounts;
    const text = announcementText({ ...base, description: 'Bring your own machine.\n\nDoors at three.' }, 'https://x');
    expect(text).toContain('· Mukkulankatu 19');
    expect(text).toContain('Bring your own machine.\n\nDoors at three.');
    // The link and the counts stay last, where the buttons follow them.
    expect(text.indexOf('Sign up:')).toBeGreaterThan(text.indexOf('Doors at three.'));
    expect(text.trimEnd().endsWith('👥 0 going')).toBe(true);
    // A description nobody could read in a channel is cut to fit, and
    // the whole message stays inside Discord's 2000 characters.
    const long = announcementText({ ...base, description: 'Sentence about the day. '.repeat(200) }, 'https://x');
    expect(long.length).toBeLessThan(2000);
    expect(long).toContain('…');
    expect(long).toContain('Sign up: https://x/events/7');
    // No description, and it reads exactly as it did before there could be one.
    expect(announcementText({ ...base, description: null }, 'https://x')).not.toContain('\n\n');
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
