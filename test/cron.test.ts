import { describe, it, expect } from 'vitest';
import { dueReminders, dueOpenings, reminderLine, openingLine, REMINDER_WINDOW } from '../src/lib/cron';

// The hourly job's choices, as pure functions.

const NOW = 1_760_000_000;
const base = { published_at: NOW - 1000, cancelled_at: null as number | null, reminder_sent_at: null as number | null, open_posted_at: null as number | null, signups_open_at: null as number | null };

describe('dueReminders', () => {
  it('picks published, upcoming events inside the last day, once', () => {
    const events = [
      { ...base, id: 1, starts_at: NOW + 3600 }, // in an hour: due
      { ...base, id: 2, starts_at: NOW + REMINDER_WINDOW }, // exactly a day: due
      { ...base, id: 3, starts_at: NOW + REMINDER_WINDOW + 1 }, // too far
      { ...base, id: 4, starts_at: NOW + 3600, reminder_sent_at: NOW - 100 }, // done
      { ...base, id: 5, starts_at: NOW - 10 }, // started
      { ...base, id: 6, starts_at: NOW + 3600, cancelled_at: NOW - 5 },
      { ...base, id: 7, starts_at: NOW + 3600, published_at: null },
    ];
    expect(dueReminders(events, NOW).map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('dueOpenings', () => {
  it('picks openings that passed within the last day and were not posted', () => {
    const events = [
      { ...base, id: 1, starts_at: NOW + 86400 * 7, signups_open_at: NOW - 60 },
      { ...base, id: 2, starts_at: NOW + 86400 * 7, signups_open_at: NOW + 60 }, // not yet
      { ...base, id: 3, starts_at: NOW + 86400 * 7, signups_open_at: NOW - 86400 - 1 }, // too old to announce
      { ...base, id: 4, starts_at: NOW + 86400 * 7, signups_open_at: NOW - 60, open_posted_at: NOW - 30 },
      { ...base, id: 5, starts_at: NOW + 86400 * 7, signups_open_at: null },
    ];
    expect(dueOpenings(events, NOW).map((e) => e.id)).toEqual([1]);
  });
});

describe('lines', () => {
  it('say when, where and how many, with the link, and no markdown from names', () => {
    const text = reminderLine({ title: 'Big **LAN**', starts_at: NOW, location: 'Hall @A', yes_count: 12, team_size: null, teams_count: 0 }, 'https://x/events/1');
    expect(text).toMatch(/^⏰ Tomorrow: \*\*Big LAN\*\*, .* · Hall A\. 12 going\.\nhttps:\/\/x\/events\/1$/);
    expect(reminderLine({ title: 'Cup', starts_at: NOW, location: null, yes_count: 9, team_size: 3, teams_count: 3 }, 'u')).toContain('3 teams in.');
    expect(openingLine({ title: 'Cup', starts_at: NOW, interest_count: 5 }, 'u')).toContain("5 people said they're interested.");
    expect(openingLine({ title: 'Cup', starts_at: NOW, interest_count: 0 }, 'u')).not.toContain('interested');
  });
});
