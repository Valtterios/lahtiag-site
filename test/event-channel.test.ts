import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, setSignup, createEventTeam, joinEventTeam, addBracket, getBracket, setBracketWinner, type BracketMatch } from '../src/lib/db';
import {
  participantNames,
  nameOf,
  roundLabel,
  signupsLine,
  bracketLine,
  describeResult,
  resultLine,
  revertLine,
  screenLine,
  cancelLine,
  changeLine,
  postEventLine,
  liveBracketText,
} from '../src/lib/event-channel';

// The lines the bot posts into an event's channel, and the bracket
// reading behind them.

const NOW = 1_760_000_000;
const db = () => env.DB;
const names = new Map([
  ['t:1', 'Alpha'],
  ['t:2', 'Bravo'],
  ['t:3', 'Charlie'],
  ['t:4', 'Delta'],
  ['t:5', 'Echo'],
  ['u:9', '@everyone **bold** [link](x)'],
]);
const m = (round: number, slot: number, a: string | null, b: string | null, winner: string | null = null): BracketMatch => ({ bracket_id: 1, event_id: 1, round, slot, side_a: a, side_b: b, winner });

describe('lines', () => {
  it('names safely and labels rounds from the end', () => {
    expect(nameOf(names, 'u:9')).toBe('everyone bold linkx');
    expect(nameOf(names, 't:99')).toBe('Unknown');
    expect(nameOf(names, null)).toBe('Unknown');
    expect([1, 2, 3, 4].map((r) => roundLabel(r, 4))).toEqual(['Round 1', 'Quarterfinal', 'Semifinal', 'Final']);
  });

  it('counts signups by kind of event', () => {
    expect(signupsLine(true, { teams: 6, players: 31 })).toBe('🔒 Signups are closed: 6 teams, 31 players in.');
    expect(signupsLine(false, { teams: null, players: 12 })).toBe('🔓 Signups are open again: 12 going.');
  });

  it('describes the draw with pairings and byes', () => {
    const matches = [m(1, 0, 't:1', 't:2'), m(1, 1, 't:3', 't:4'), m(1, 2, 't:5', null, 't:5'), m(1, 3, null, null), m(2, 0, null, null), m(2, 1, 't:5', null), m(3, 0, null, null)];
    const text = bracketLine(matches, names, 'https://x/events/1/bracket', false);
    expect(text).toContain('🎲 The bracket is out: 5 teams, 3 rounds.');
    expect(text).toContain('Quarterfinal: Alpha vs Bravo · Charlie vs Delta.');
    expect(text).toContain('Echo skips straight to semifinal.');
    expect(text.endsWith('https://x/events/1/bracket')).toBe(true);
    expect(bracketLine(matches, names, 'u', true)).toContain('The bracket was redrawn');
  });

  it('tells a result with the next opponent, and crowns the champion at the final', () => {
    const matches = [m(1, 0, 't:1', 't:2', 't:1'), m(1, 1, 't:3', 't:4', 't:3'), m(2, 0, 't:1', 't:3')];
    const semi = describeResult(matches, 1, 0, names)!;
    expect(semi).toEqual({ round: 1, totalRounds: 2, winner: 'Alpha', loser: 'Bravo', next: { a: 'Alpha', b: 'Charlie' } });
    expect(resultLine(semi, 'u')).toBe('🏆 Semifinal: Alpha beat Bravo. Next up: Alpha vs Charlie.');
    expect(describeResult(matches, 2, 0, names)).toBeNull(); // undecided
    const done = [...matches.slice(0, 2), m(2, 0, 't:1', 't:3', 't:3')];
    expect(resultLine(describeResult(done, 2, 0, names)!, 'https://x')).toBe('🥇 Champion: **Charlie**! They beat Alpha in the final.\nhttps://x');
    expect(revertLine(1, 2, 'Alpha', 'Bravo')).toBe('↩️ Semifinal: Alpha vs Bravo is undecided again.');
  });

  it('renders the live bracket with ticks, byes, dashes and the champion, and never past one message', () => {
    const matches = [m(1, 0, 't:1', 't:2', 't:1'), m(1, 1, 't:3', 't:4'), m(1, 2, 't:5', null, 't:5'), m(1, 3, null, null), m(2, 0, 't:1', null), m(2, 1, 't:5', null), m(3, 0, null, null)];
    const text = liveBracketText(matches, names, 'https://x/b', NOW);
    expect(text).toContain('📋 **Live bracket** · updated ');
    expect(text).toContain('**Quarterfinals**\nAlpha ✅ vs Bravo\nCharlie vs Delta\nEcho advances (bye)\n— vs —');
    expect(text).toContain('**Semifinals**\nAlpha vs —\nEcho vs —');
    expect(text).toContain('**Final**\n— vs —');
    expect(text).not.toContain('Champion');
    expect(text.endsWith('https://x/b')).toBe(true);
    const done = [m(1, 0, 't:1', 't:2', 't:2')];
    expect(liveBracketText(done, names, 'u', NOW)).toContain('🥇 Champion: **Bravo**');

    // 64 long names in round one: the earliest rounds give way.
    const big: BracketMatch[] = [];
    const wide = new Map<string, string>();
    for (let i = 0; i < 32; i++) {
      wide.set(`u:${i}a`, `Player with a long name ${i}A`);
      wide.set(`u:${i}b`, `Player with a long name ${i}B`);
      big.push(m(1, i, `u:${i}a`, `u:${i}b`));
    }
    for (let r = 2; r <= 6; r++) for (let s = 0; s < 64 / 2 ** r; s++) big.push(m(r, s, null, null));
    const long = liveBracketText(big, wide, 'https://x/b', NOW);
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(long).toContain('… earlier rounds on the site');
    expect(long).toContain('**Final**');
  });

  it('keeps screen messages and titles free of markdown, and speaks only of a new time or place', () => {
    expect(screenLine('Finals in **5** minutes @everyone')).toBe('📺 Finals in 5 minutes everyone');
    expect(cancelLine({ title: 'LAN', starts_at: NOW }, true)).toMatch(/^❌ \*\*LAN\*\* is cancelled \(was /);
    expect(cancelLine({ title: 'LAN', starts_at: NOW }, false)).toMatch(/^✅ \*\*LAN\*\* is back on: /);
    const before = { starts_at: NOW, ends_at: NOW + 3600, location: 'Hall A' };
    expect(changeLine(before, { ...before })).toBeNull();
    expect(changeLine(before, { ...before, location: 'Hall B' })).toBe('✏️ new place: Hall B.');
    expect(changeLine(before, { ...before, location: null })).toBe('✏️ the place was removed.');
    expect(changeLine(before, { ...before, starts_at: NOW + 7200 })).toMatch(/^✏️ new time: /);
    expect(changeLine(before, { starts_at: NOW + 7200, ends_at: NOW + 9000, location: 'Hall B' })).toMatch(/^✏️ new time: .*; new place: Hall B\.$/);
  });
});

describe('against the database', () => {
  beforeEach(async () => {
    for (const table of ['bracket_matches', 'brackets', 'signups', 'event_teams', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
  });

  it('resolves keys to names and reads a real bracket back', async () => {
    await upsertMember(db(), { discord_id: '100', username: 'Host', avatar_hash: null }, NOW);
    const id = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, team_size: 2, created_by: '100' }, NOW);
    for (const who of ['1', '2', '3', '4']) await upsertMember(db(), { discord_id: who, username: `p${who}`, avatar_hash: null }, NOW);
    const a = await createEventTeam(db(), id, 'Alpha', '1', NOW);
    await joinEventTeam(db(), id, a, '2', NOW);
    const b = await createEventTeam(db(), id, 'Bravo', '3', NOW);
    await joinEventTeam(db(), id, b, '4', NOW);
    const map = await participantNames(db(), id);
    expect(map.get(`t:${a}`)).toBe('Alpha');
    expect(map.get('u:3')).toBe('p3');
    const bracket = await addBracket(db(), id, null, NOW);
    const first = (await getBracket(db(), bracket))[0];
    await setBracketWinner(db(), bracket, 1, 0, first.side_a!);
    const story = describeResult(await getBracket(db(), bracket), 1, 0, map)!;
    expect(story.round).toBe(1);
    expect(story.totalRounds).toBe(1);
    expect(['Alpha', 'Bravo']).toContain(story.winner);
    expect(resultLine(story, 'u')).toContain('🥇 Champion');
  });

  it('posts nothing without a bot or a channel', async () => {
    await upsertMember(db(), { discord_id: '100', username: 'Host', avatar_hash: null }, NOW);
    const id = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: '100' }, NOW);
    await setSignup(db(), id, '100', 'yes', NOW);
    expect(await postEventLine(db(), {}, id, 'hi')).toBe(false);
    expect(await postEventLine(db(), { DISCORD_BOT_TOKEN: 'tok' }, id, 'hi')).toBe(false);
  });
});
