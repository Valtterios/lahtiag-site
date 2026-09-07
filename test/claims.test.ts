import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listClaimableKinds, createClaim, decideClaim, listPendingClaims, memberPendingClaims, claimLine, claimDecisionDm } from '../src/lib/claims';
import { addTickKind, listTickKinds, listTicks, saveTickKind, giveTick } from '../src/lib/ticks';
import { deleteEvent, eraseRegisterEntry } from '../src/lib/db';
import { seasonSummary, seasonLines } from '../src/lib/season';

const NOW = Date.UTC(2026, 8, 7, 12) / 1000;
const AINO = '100000000000000001';
const BO = '100000000000000002';
const ORIGIN = 'https://lahtiag.fi';

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

describe('tick claims', () => {
  it('lets a member ask for a claimable kind, once, and the board decide', async () => {
    const [helped] = await listTickKinds(env.DB);
    expect(helped.claimable).toBe(true);
    expect((await listClaimableKinds(env.DB)).map((k) => k.name)).toEqual(['Helped at an event']);
    const quiet = await addTickKind(env.DB, { name: 'Board only', description: '', xp: '10', season_cap: '' }, 'axi', NOW);
    expect(quiet.claimable).toBe(false);
    expect((await listClaimableKinds(env.DB)).length).toBe(1);

    const aino = await member('Aino Virtanen', AINO);
    await member('Bo Berg', BO, 'former');
    const lan = await event('Autumn LAN', Date.UTC(2026, 8, 5, 10) / 1000);

    await expect(createClaim(env.DB, { discordId: BO, kindId: helped.id, eventId: lan }, NOW)).rejects.toMatchObject({ code: 'not_member' });
    await expect(createClaim(env.DB, { discordId: '999', kindId: helped.id, eventId: null }, NOW)).rejects.toMatchObject({ code: 'not_member' });
    await expect(createClaim(env.DB, { discordId: AINO, kindId: quiet.id, eventId: null }, NOW)).rejects.toMatchObject({ code: 'missing' });
    await expect(createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: 999 }, NOW)).rejects.toMatchObject({ code: 'missing' });

    const claim = await createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: lan, note: '  Ran the  desk ' }, NOW);
    expect(claim).toMatchObject({ kind: 'Helped at an event', xp: 100, member: 'Aino Virtanen', discord_id: AINO, event: 'Autumn LAN', note: 'Ran the desk', status: 'pending', tick_id: null });
    expect(claimLine(claim, ORIGIN)).toBe(`🙋 **Tick claim**: <@${AINO}> asks for **Helped at an event** for *Autumn LAN*: “Ran the desk” (100 XP). Approve below or at ${ORIGIN}/board/season#claims`);
    await expect(createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: lan }, NOW)).rejects.toMatchObject({ code: 'duplicate' });
    // Without an event is another claim; twice is not.
    const loose = await createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: null }, NOW + 1);
    await expect(createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: null }, NOW + 2)).rejects.toMatchObject({ code: 'duplicate' });
    expect((await listPendingClaims(env.DB)).map((c) => c.id)).toEqual([claim.id, loose.id]);
    expect(await memberPendingClaims(env.DB, AINO, NOW)).toBe(2);
    const summary = await seasonSummary(env.DB, AINO, NOW);
    expect(summary.claims_pending).toBe(2);
    expect(seasonLines(summary, ORIGIN)).toContain('⏳ Claims waiting for the board: **2**');

    // Approving gives the tick with the claim's note; the member sees it.
    const approved = await decideClaim(env.DB, claim.id, 'approve', 'axi', NOW + 10);
    expect(approved?.claim).toMatchObject({ status: 'approved', decided_by: 'axi', decided_at: NOW + 10 });
    expect(approved?.tick).toMatchObject({ kind: 'Helped at an event', event: 'Autumn LAN', note: 'Ran the desk', xp: 100, given_by: 'axi' });
    expect(approved?.claim.tick_id).toBe(approved?.tick?.id);
    expect(claimDecisionDm(approved!.claim, ORIGIN)).toContain('✅ The board approved your claim: **Helped at an event** for Autumn LAN, 100 XP.');
    expect(await decideClaim(env.DB, claim.id, 'approve', 'axi', NOW + 11)).toBeNull();
    // A tick already given for the event refuses a second claim.
    await expect(createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: lan }, NOW + 12)).rejects.toMatchObject({ code: 'duplicate' });

    const declined = await decideClaim(env.DB, loose.id, 'decline', 'jc', NOW + 20);
    expect(declined?.claim.status).toBe('declined');
    expect(declined?.tick).toBeNull();
    expect(claimDecisionDm(declined!.claim, ORIGIN)).toBe("The board didn't approve your claim for **Helped at an event**. Ask a board member if you want to know more.");
    expect(await listPendingClaims(env.DB)).toEqual([]);
    expect(await memberPendingClaims(env.DB, AINO, NOW)).toBe(0);
    expect((await listTicks(env.DB, 2026)).length).toBe(1);

    // Approving over an event tick already given by hand is refused, and
    // the claim stays pending for the board to decline.
    const another = await event('Board games', Date.UTC(2026, 8, 6, 10) / 1000);
    const c2 = await createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: another }, NOW + 30);
    await giveTick(env.DB, { kindId: helped.id, registerId: aino, eventId: another }, 'axi', NOW + 31);
    await expect(decideClaim(env.DB, c2.id, 'approve', 'axi', NOW + 32)).rejects.toMatchObject({ code: 'duplicate' });
    expect((await listPendingClaims(env.DB)).length).toBe(1);

    // A kind taken off the claim list refuses new claims; retiring the
    // claimable flag is a save like any other.
    await saveTickKind(env.DB, helped.id, { name: 'Helped at an event', description: '', xp: '100', season_cap: '1', claimable: '' });
    expect(await listClaimableKinds(env.DB)).toEqual([]);
    await expect(createClaim(env.DB, { discordId: AINO, kindId: helped.id, eventId: null }, NOW + 40)).rejects.toMatchObject({ code: 'missing' });
    await saveTickKind(env.DB, helped.id, { name: 'Helped at an event', description: '', xp: '100', season_cap: '1', claimable: 'on' });
    expect((await listClaimableKinds(env.DB)).length).toBe(1);

    // Deleting the event keeps the claim without it; erasing the member takes the claims along.
    await deleteEvent(env.DB, another);
    expect((await listPendingClaims(env.DB))[0]).toMatchObject({ event_id: null, event: null });
    await eraseRegisterEntry(env.DB, aino);
    expect(await listPendingClaims(env.DB)).toEqual([]);
  });
});
