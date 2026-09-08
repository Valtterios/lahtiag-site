import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember } from '../src/lib/db';
import { cardFace, memberCardPng } from '../src/lib/member-card';
import { decodePng } from '../src/lib/png-decode';

// The card that goes to Discord. What matters here is what it refuses to
// carry: /profile is public and works on anybody, so nothing the register
// keeps behind its own sign-in may reach it, and hiding yourself has to
// take the numbers off.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['register', 'members', 'signups', 'events', 'discord_activity']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function entry(discordId: string, type = 'full', extra = ''): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, status, source, applied_at, consented_at, decided_at, updated_at, search_key${extra ? `, ${extra}` : ''})
       VALUES ('Valtteri Östberg', 'Lahti', ?2, 'LUT', 'LTKY', ?3, ?1, 'member', 'board', 1, 1, 1, 1, 'v'${extra ? ', 1' : ''})`,
    )
    .bind(discordId, `${discordId}@example.com`, type)
    .run();
}

const who = (discordId: string, board = false) => ({ discordId, name: 'Axinikk', avatarHash: null, board });

beforeEach(wipe);

describe('the card Discord gets', () => {
  it('takes its stock from the class in the rules, and the board over all of them', async () => {
    await entry('1');
    expect((await cardFace(db(), who('1'), NOW)).tier).toBe('member');
    await wipe();
    await entry('2', 'external');
    expect((await cardFace(db(), who('2'), NOW)).tier).toBe('plain');
    await wipe();
    await entry('3', 'supporting');
    expect((await cardFace(db(), who('3'), NOW)).tier).toBe('plain');
    await wipe();
    await entry('4', 'honorary');
    expect((await cardFace(db(), who('4'), NOW)).tier).toBe('honorary');
    await wipe();
    await entry('5', 'honorary');
    expect((await cardFace(db(), who('5', true), NOW)).tier).toBe('board');
  });

  it('gives someone with no membership the white stock, not a member card', async () => {
    const face = await cardFace(db(), who('9'), NOW);
    expect(face.tier).toBe('plain');
    expect(face.memberSince).toBeNull();
  });

  it('wears the founder flag', async () => {
    await entry('6', 'full', 'founder');
    expect((await cardFace(db(), who('6'), NOW)).founder).toBe(true);
  });

  it('drops every figure when the member has hidden themselves', async () => {
    await entry('7');
    await upsertMember(db(), { discord_id: '7', username: 'Axinikk', avatar_hash: null }, NOW);
    await db().prepare('INSERT INTO discord_activity (discord_id, day, messages, voice_minutes, updated_at) VALUES (?1, ?2, 20, 5, 1)').bind('7', '2026-09-01').run();

    const shown = await cardFace(db(), who('7'), NOW);
    expect(shown.figures.map((f) => f.label)).toEqual(['Events', 'Wins', 'Messages', 'Minecraft']);
    expect(shown.figures[2].value).toBe('20');
    expect(shown.record.length).toBeGreaterThan(0);

    await db().prepare('UPDATE members SET leaderboard_hidden = 1 WHERE discord_id = ?1').bind('7').run();
    const hidden = await cardFace(db(), who('7'), NOW);
    expect(hidden.figures).toEqual([]);
    expect(hidden.record).toEqual([]);
    // The card is still theirs: the stock and the date stay.
    expect(hidden.tier).toBe('member');
  });

  it('draws both sides as a PNG of the card’s own proportions, corners cut', async () => {
    await entry('8');
    const face = await cardFace(db(), who('8'), NOW);
    for (const back of [false, true]) {
      const decoded = await decodePng(await memberCardPng(face, back));
      expect(decoded).not.toBeNull();
      expect(decoded!.width / decoded!.height).toBeCloseTo(1.586, 2);
      // The very corner is cut away; the middle is not.
      expect(decoded!.rgba[3]).toBe(0);
      const middle = ((decoded!.height >> 1) * decoded!.width + (decoded!.width >> 1)) * 4;
      expect(decoded!.rgba[middle + 3]).toBe(255);
    }
  });
});
