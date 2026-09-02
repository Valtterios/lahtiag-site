import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { formatHelsinkiRange, helsinkiToUnix } from '../src/lib/time';
import { upsertMember, createEvent, listUpcomingEvents, listPastEvents } from '../src/lib/db';

const db = () => env.DB;
const NOW = helsinkiToUnix('2026-01-15', '19:00')!;

async function wipe(): Promise<void> {
  for (const table of ['bracket_matches', 'signups', 'event_teams', 'events', 'announcements', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(wipe);

describe('formatHelsinkiRange', () => {
  it('shows just the end time on a same-day range', () => {
    const start = helsinkiToUnix('2026-01-15', '18:00')!;
    expect(formatHelsinkiRange(start, start + 4 * 3600)).toBe('Thu, 15 Jan 2026, 18:00 to 22:00');
  });

  it('shows the full end timestamp for an overnight range', () => {
    const start = helsinkiToUnix('2026-01-15', '20:00')!;
    const text = formatHelsinkiRange(start, start + 8 * 3600);
    expect(text).toContain('16 Jan 2026');
    expect(text).toContain('04:00');
  });

  it('falls back to the start alone without an end', () => {
    const start = helsinkiToUnix('2026-01-15', '18:00')!;
    expect(formatHelsinkiRange(start, null)).toBe('Thu, 15 Jan 2026, 18:00');
  });
});

describe('ends_at rules', () => {
  async function seed(startsOffset: number, endsOffset: number | null): Promise<number> {
    await upsertMember(db(), { discord_id: 'admin', username: 'admin', avatar_hash: null }, NOW);
    return createEvent(
      db(),
      {
        title: 'Scheduled',
        description: null,
        starts_at: NOW + startsOffset,
        ends_at: endsOffset === null ? null : NOW + endsOffset,
        capacity: null,
        created_by: 'admin',
      },
      NOW,
    );
  }

  it('rejects an end at or before the start', async () => {
    await expect(seed(3600, 3600)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(seed(3600, 1800)).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('keeps an ongoing event in the upcoming list, not the past list', async () => {
    const id = await seed(-3600, 3600); // started an hour ago, ends in an hour
    const upcoming = await listUpcomingEvents(db(), NOW);
    expect(upcoming.map((e) => e.id)).toContain(id);
    expect((await listPastEvents(db(), NOW)).map((e) => e.id)).not.toContain(id);
  });

  it('moves an ended event to the past list', async () => {
    const id = await seed(-7200, -3600);
    expect((await listUpcomingEvents(db(), NOW)).map((e) => e.id)).not.toContain(id);
    expect((await listPastEvents(db(), NOW)).map((e) => e.id)).toContain(id);
  });
});
