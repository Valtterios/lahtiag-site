import { describe, it, expect } from 'vitest';
import { dueReminders, dueOpenings, dueSalesReminder, reminderLine, openingLine, salesLine, digestText, milestoneLine, helsinkiClock, REMINDER_WINDOW } from '../src/lib/cron';

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
    expect(openingLine({ title: 'Cup', starts_at: NOW, interest_count: 1 }, 'u')).toContain("1 person said they're interested.");
    expect(reminderLine({ title: 'Cup', starts_at: NOW, location: null, yes_count: 0, team_size: null, teams_count: 0 }, 'u')).toContain('no signups yet.');
    expect(openingLine({ title: 'Cup', starts_at: NOW, interest_count: 0 }, 'u')).not.toContain('interested');
  });
});

describe('dueSalesReminder', () => {
  const ev = { ...base, starts_at: NOW + 86400 * 5, sales_reminder_sent_at: null as number | null };
  const type = (closes: number | null, quantity: number | null, sold = 0, active = 1) => ({ active, sales_close_at: closes, quantity, sold });

  it('takes the earliest deadline inside a day, with what is left when every type is capped', () => {
    expect(dueSalesReminder(ev, [type(NOW + 3600, 10, 4), type(NOW + 7200, 5, 5)], NOW)).toEqual({ closesAt: NOW + 3600, left: 6 });
    expect(dueSalesReminder(ev, [type(NOW + 3600, 10, 4), type(NOW + 7200, null)], NOW)).toEqual({ closesAt: NOW + 3600, left: null });
    expect(dueSalesReminder(ev, [type(NOW + REMINDER_WINDOW + 1, 10)], NOW)).toBeNull(); // too far
    expect(dueSalesReminder(ev, [type(NOW - 1, 10)], NOW)).toBeNull(); // closed already
    expect(dueSalesReminder(ev, [type(null, 10)], NOW)).toBeNull(); // closes at the start: the day-before reminder covers it
    expect(dueSalesReminder(ev, [type(NOW + 3600, 10, 0, 0)], NOW)).toBeNull(); // retired type
    expect(dueSalesReminder({ ...ev, sales_reminder_sent_at: NOW - 5 }, [type(NOW + 3600, 10)], NOW)).toBeNull();
    expect(salesLine({ title: 'Cup' }, NOW + 3600, 6, 'u')).toMatch(/^🎟️ Ticket sales for \*\*Cup\*\* close .*\. 6 left\.\nu$/);
    expect(salesLine({ title: 'Cup' }, NOW + 3600, 0, 'u')).toContain('Sold out.');
    expect(salesLine({ title: 'Cup' }, NOW + 3600, null, 'u')).not.toContain('left');
  });
});

describe('digest and milestones', () => {
  it('reads the Helsinki clock', () => {
    // 2026-09-07 06:00 UTC is Monday 09:00 in Helsinki (EEST).
    expect(helsinkiClock(Date.UTC(2026, 8, 7, 6, 0) / 1000)).toEqual({ weekday: 1, hour: 9 });
    expect(helsinkiClock(Date.UTC(2026, 8, 6, 22, 30) / 1000)).toEqual({ weekday: 1, hour: 1 });
  });

  it('writes the digest only when there is something to say', () => {
    expect(digestText([], [], 0, 'u')).toBeNull();
    const text = digestText(
      [{ id: 1, title: 'LAN **x**', starts_at: NOW, yes_count: 12, interest_count: 3, team_size: null, teams_count: 0 }],
      [{ champion_name: 'Alpha', title: 'Cup' }],
      2,
      'https://x',
    )!;
    expect(text).toContain('📬 **This week at LahtiAG**');
    expect(text).toContain('**LAN x** · 12 going · ♡ 3 · https://x/events/1');
    expect(text).toContain("🏆 Last week's champion: **Alpha** (Cup)");
    expect(text).toContain('👋 2 new members joined last week.');
    expect(digestText([], [], 1, 'u')).toContain('1 new member joined');
    expect(milestoneLine('Axi', 10)).toBe('🎉 **Axi** just attended their 10th LahtiAG event!');
    expect(milestoneLine('Axi', 25)).toContain('25th');
  });
});
