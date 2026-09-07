import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  listTickKinds,
  addTickKind,
  saveTickKind,
  setTickKindRetired,
  listTickableMembers,
  giveTick,
  removeTick,
  listTicks,
  memberSeasonTicks,
  seasonRange,
  tickList,
  tickXp,
  kindWorth,
  applyCaps,
  periodKey,
  markCounted,
} from '../src/lib/ticks';
import { RuleError, deleteEvent, eraseRegisterEntry } from '../src/lib/db';
import { seasonSummary, seasonLines } from '../src/lib/season';

const NOW = Date.UTC(2026, 8, 7, 12) / 1000; // 7 September 2026
const LAST_SEASON = Date.UTC(2026, 4, 3, 12) / 1000; // 3 May 2026
const AINO = '100000000000000001';
const BO = '100000000000000002';

async function member(name: string, discordId: string | null, status = 'member'): Promise<number> {
  const result = await env.DB
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, status, source, applied_at, consented_at, updated_at, search_key)
       VALUES (?1, 'Lahti', ?2, 'LUT', 'LTKY', 'full', ?3, ?4, 'board', 1, 1, 1, lower(?1))`,
    )
    .bind(name, `${name.toLowerCase().replace(/ /g, '.')}@example.com`, discordId, status)
    .run();
  return Number(result.meta.last_row_id);
}

async function event(title: string, startsAt: number): Promise<number> {
  await env.DB.prepare("INSERT OR IGNORE INTO members (discord_id, username, last_seen) VALUES (?1, 'Aino', 1)").bind(AINO).run();
  const result = await env.DB
    .prepare('INSERT INTO events (title, starts_at, created_by, created_at, published_at) VALUES (?1, ?2, ?3, 1, 1)')
    .bind(title, startsAt, AINO)
    .run();
  return Number(result.meta.last_row_id);
}

describe('tick kinds', () => {
  it('starts with helping at an event and lets the board add more', async () => {
    const before = await listTickKinds(env.DB);
    expect(before.map((k) => k.name)).toEqual(['Helped at an event']);
    expect(before[0]).toMatchObject({ xp: 100, season_cap: 1, period: 'season' });
    expect(kindWorth(before[0])).toBe('100 XP · once a season');
    const kind = await addTickKind(env.DB, { name: '  Brought  gear ', description: 'Lent a console or a screen.', xp: '50', season_cap: '' }, 'axi', NOW);
    expect(kind).toMatchObject({ name: 'Brought gear', description: 'Lent a console or a screen.', sort: 2, xp: 50, season_cap: 0, period: 'season', retired_at: null, given: 0 });
    expect(kindWorth(kind)).toBe('50 XP');
    expect(kindWorth({ xp: 0, season_cap: 0, period: 'season' })).toBe('no XP yet');
    expect(kindWorth({ xp: 20, season_cap: 3, period: 'season' })).toBe('20 XP · up to 3 a season');
    expect(kindWorth({ xp: 20, season_cap: 1, period: 'month' })).toBe('20 XP · once a month');
    expect(kindWorth({ xp: 20, season_cap: 2, period: 'week' })).toBe('20 XP · up to 2 a week');
    const monthly = await addTickKind(env.DB, { name: 'Ran a game night', description: '', xp: '40', season_cap: '1', period: 'month' }, 'axi', NOW);
    expect(monthly).toMatchObject({ period: 'month', season_cap: 1 });
    await expect(addTickKind(env.DB, { name: 'Bad period', description: '', xp: '', season_cap: '', period: 'day' }, 'axi', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    const blank = { description: '', xp: '', season_cap: '' };
    await expect(addTickKind(env.DB, { ...blank, name: 'brought GEAR' }, 'axi', NOW)).rejects.toMatchObject({ code: 'duplicate' });
    await expect(addTickKind(env.DB, { ...blank, name: 'x' }, 'axi', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(addTickKind(env.DB, { ...blank, name: 'Bad XP', xp: '1.5' }, 'axi', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(addTickKind(env.DB, { ...blank, name: 'Bad cap', season_cap: '-1' }, 'axi', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    const saved = await saveTickKind(env.DB, kind.id, { ...blank, name: 'Brought equipment', xp: '60', season_cap: '2', period: 'week' });
    expect(saved).toMatchObject({ name: 'Brought equipment', description: null, xp: 60, season_cap: 2, period: 'week' });
    await expect(saveTickKind(env.DB, kind.id, { ...blank, name: 'Helped at an event' })).rejects.toMatchObject({ code: 'duplicate' });
    expect(await setTickKindRetired(env.DB, kind.id, true, NOW)).toBe(true);
    expect((await listTickKinds(env.DB)).map((k) => k.name)).toEqual(['Helped at an event', 'Ran a game night']);
    expect((await listTickKinds(env.DB, true)).map((k) => [k.name, k.retired_at])).toEqual([
      ['Helped at an event', null],
      ['Brought equipment', NOW],
      ['Ran a game night', null],
    ]);
    expect(await setTickKindRetired(env.DB, kind.id, false, NOW)).toBe(true);
    expect((await listTickKinds(env.DB)).length).toBe(3);
    expect(await setTickKindRetired(env.DB, 999, true, NOW)).toBe(false);
  });
});

describe('giving ticks', () => {
  it('goes to current members, once per event, and shows up in their season', async () => {
    const aino = await member('Aino Virtanen', AINO);
    const bo = await member('Bo Berg', BO, 'former');
    await member('Cecilia Pending', null, 'pending');
    expect((await listTickableMembers(env.DB)).map((m) => m.full_name)).toEqual(['Aino Virtanen']);
    const lan = await event('Autumn LAN', Date.UTC(2026, 8, 5, 10) / 1000);
    const [helped] = await listTickKinds(env.DB);

    const tick = await giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: lan, note: ' Ran the  desk ' }, 'axi', NOW);
    expect(tick).toMatchObject({ kind: 'Helped at an event', member: 'Aino Virtanen', discord_id: AINO, event: 'Autumn LAN', note: 'Ran the desk', xp: 100, given_by: 'axi', given_at: NOW });
    await expect(giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: lan }, 'axi', NOW)).rejects.toMatchObject({ code: 'duplicate' });
    await expect(giveTick(env.DB, { kindId: helped.id, registerId: bo, eventId: null }, 'axi', NOW)).rejects.toMatchObject({ code: 'not_member' });
    await expect(giveTick(env.DB, { kindId: helped.id, registerId: 999, eventId: null }, 'axi', NOW)).rejects.toMatchObject({ code: 'missing' });
    await expect(giveTick(env.DB, { kindId: 999, registerId: aino, eventId: null }, 'axi', NOW)).rejects.toMatchObject({ code: 'missing' });
    await expect(giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: 999 }, 'axi', NOW)).rejects.toMatchObject({ code: 'missing' });
    // Without an event, as often as the board sees fit.
    await giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: null }, 'axi', NOW + 60);
    // A tick from last season stays there.
    await giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: null, note: 'spring' }, 'axi', LAST_SEASON);

    const season = await listTicks(env.DB, 2026);
    expect(season.map((t) => [t.event, t.note])).toEqual([
      [null, null],
      ['Autumn LAN', 'Ran the desk'],
    ]);
    expect((await listTicks(env.DB, 2025)).map((t) => t.note)).toEqual(['spring']);
    expect((await listTicks(env.DB, 2026, { eventId: lan })).length).toBe(1);
    expect((await listTicks(env.DB, 2026, { eventId: lan })).length).toBe(1);
    expect((await listTicks(env.DB, 2026, { limit: 1 })).length).toBe(1);

    const mine = await memberSeasonTicks(env.DB, AINO, NOW);
    expect(mine).toEqual([
      { kind_id: helped.id, kind: 'Helped at an event', event: 'Autumn LAN', given_at: NOW, xp: 100, season_cap: 1, period: 'season' },
      { kind_id: helped.id, kind: 'Helped at an event', event: null, given_at: NOW + 60, xp: 100, season_cap: 1, period: 'season' },
    ]);
    expect(tickList(mine)).toBe('Helped at an event (Autumn LAN) · Helped at an event');
    // Once a season: the second one is noted, not paid.
    expect(tickXp(mine)).toBe(100);
    expect(applyCaps(mine, (t) => t).map((t) => t.counted)).toEqual([true, false]);
    expect(tickXp(mine.map((t) => ({ ...t, season_cap: 0 })))).toBe(200);
    expect(tickXp([...mine, { kind_id: 99, kind: 'Other', event: null, given_at: NOW, xp: 30, season_cap: 2, period: 'season' as const }])).toBe(130);
    // The board's list flags each member's ticks by their own caps.
    const flagged = markCounted(await listTicks(env.DB, 2026), await listTickKinds(env.DB, true));
    expect(flagged.map((t) => [t.event, t.counted])).toEqual([
      [null, false],
      ['Autumn LAN', true],
    ]);
    // A tick keeps the XP it was given with; the season's can be brought along.
    await saveTickKind(env.DB, helped.id, { name: 'Helped at an event', description: '', xp: '150', season_cap: '1' });
    expect((await memberSeasonTicks(env.DB, AINO, NOW)).map((t) => t.xp)).toEqual([100, 100]);
    await saveTickKind(env.DB, helped.id, { name: 'Helped at an event', description: '', xp: '150', season_cap: '1' }, 2026);
    expect((await memberSeasonTicks(env.DB, AINO, NOW)).map((t) => t.xp)).toEqual([150, 150]);
    expect((await listTicks(env.DB, 2025)).map((t) => t.xp)).toEqual([100]);
    await saveTickKind(env.DB, helped.id, { name: 'Helped at an event', description: '', xp: '100', season_cap: '1' }, 2026);
    expect(await memberSeasonTicks(env.DB, BO, NOW)).toEqual([]);
    expect((await listTickKinds(env.DB))[0].given).toBe(3);

    const summary = await seasonSummary(env.DB, AINO, NOW);
    expect(summary.ticks.length).toBe(2);
    expect(summary.tick_xp).toBe(100);
    expect(seasonLines(summary, 'https://lahtiag.fi')).toContain('✅ Ticks from the board: **2** · Helped at an event (Autumn LAN) · Helped at an event · **100 XP**');

    // Deleting the event keeps the tick, without the event; erasing the
    // member takes their ticks with them; removing one is removing one.
    await deleteEvent(env.DB, lan);
    expect((await listTicks(env.DB, 2026)).map((t) => t.event)).toEqual([null, null]);
    const gone = await removeTick(env.DB, tick.id);
    expect(gone?.id).toBe(tick.id);
    expect(await removeTick(env.DB, tick.id)).toBeNull();
    expect((await listTicks(env.DB, 2026)).length).toBe(1);
    expect(await eraseRegisterEntry(env.DB, aino)).toBe(true);
    expect((await listTicks(env.DB, 2026)).length).toBe(0);
    expect((await listTicks(env.DB, 2025)).length).toBe(0);
  });

  it('counts a monthly or weekly cap in the period the tick was given', () => {
    const at = (m: number, d: number, h = 12) => Date.UTC(2026, m - 1, d, h) / 1000;
    expect(periodKey(at(9, 7), 'season')).toBe('');
    expect(periodKey(at(9, 7), 'month')).toBe('2026-09');
    expect(periodKey(at(9, 30, 22), 'month')).toBe('2026-10'); // 01:00 on 1 October in Helsinki
    expect(periodKey(at(9, 7), 'week')).toBe('2026-09-07');
    expect(periodKey(at(9, 13, 20), 'week')).toBe('2026-09-07'); // Sunday night, still that week
    expect(periodKey(at(9, 13, 22), 'week')).toBe('2026-09-14'); // 01:00 Monday in Helsinki
    const tick = (kind_id: number, given_at: number, xp: number, season_cap: number, period: 'season' | 'month' | 'week') => ({
      kind_id,
      kind: 'x',
      event: null,
      given_at,
      xp,
      season_cap,
      period,
    });
    // Once a month: two in September pay once, October pays again.
    const monthly = [tick(1, at(9, 3), 40, 1, 'month'), tick(1, at(9, 20), 40, 1, 'month'), tick(1, at(10, 2), 40, 1, 'month')];
    expect(applyCaps(monthly, (t) => t).map((t) => t.counted)).toEqual([true, false, true]);
    expect(tickXp(monthly)).toBe(80);
    // Twice a week, given out of order: the oldest two of the week count.
    const weekly = [tick(2, at(9, 9), 10, 2, 'week'), tick(2, at(9, 7), 10, 2, 'week'), tick(2, at(9, 8), 10, 2, 'week'), tick(2, at(9, 14), 10, 2, 'week')];
    expect(applyCaps(weekly, (t) => t).map((t) => t.counted)).toEqual([false, true, true, true]);
    expect(tickXp(weekly)).toBe(30);
    // Kinds don't share buckets.
    expect(tickXp([...monthly, ...weekly])).toBe(110);
  });

  it('cuts a season at 1 September, Helsinki time', () => {
    const { from, to } = seasonRange(2026);
    expect(from).toBe(Date.UTC(2026, 7, 31, 21) / 1000);
    expect(to).toBe(Date.UTC(2027, 7, 31, 21) / 1000);
    expect(new RuleError('missing', 'x').code).toBe('missing');
  });
});
