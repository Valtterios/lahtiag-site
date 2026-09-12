import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ensureWallet, balance, ledger, grantCoins, payPurse, openMarket, closeMarket, reopenMarket, placeBet, cancelBet, refundStaleBets, odds, settleMarket, unsettleMarket, getMarket, marketState, richest, START_COINS, MONTHLY_ALLOWANCE, CHAMPION_PURSE } from '../src/lib/coins';
import { RuleError, upsertMember, createEvent } from '../src/lib/db';

// Play money: the purse, the allowance, a pool shared by the ones who
// picked the champion, and a reverted final undoing it all.

const NOW = 1_760_000_000; // a Thursday in October 2025
const A = '100000000000000001', B = '100000000000000002', C = '100000000000000003', OUT = '100000000000000009';
const db = () => env.DB;

async function member(id: string, name: string, hidden = 0): Promise<void> {
  await upsertMember(db(), { discord_id: id, username: name, avatar_hash: null }, NOW);
  await db().prepare(`INSERT INTO register (full_name, domicile, email, student_status, union_member, member_type, discord_id, discord_name, status, source, applied_at, consented_at, updated_at, search_key)
       VALUES (?1, 'Lahti', ?2, 'LUT', 'LTKY', 'full', ?3, ?1, 'member', 'board', 1, 1, 1, lower(?1))`).bind(name, `${name.toLowerCase()}@example.com`, id).run();
  await db().prepare('UPDATE members SET leaderboard_hidden = ?2 WHERE discord_id = ?1').bind(id, hidden).run();
}

describe('coins', () => {
  let eventId: number;
  beforeEach(async () => {
    for (const t of ['coin_bets', 'coin_markets', 'coin_ledger', 'events', 'register', 'members']) await db().prepare(`DELETE FROM ${t}`).run();
    await member(A, 'Aino'); await member(B, 'Pekka'); await member(C, 'Kai', 1);
    await upsertMember(db(), { discord_id: OUT, username: 'Guest', avatar_hash: null }, NOW);
    eventId = await createEvent(db(), { title: 'Cup', description: null, starts_at: NOW + 86400, capacity: null, created_by: A }, NOW);
  });

  it('opens a wallet with the purse and one allowance a month, members only', async () => {
    expect(await ensureWallet(db(), A, NOW)).toEqual({ started: true, allowance: true });
    expect(await balance(db(), A)).toBe(START_COINS + MONTHLY_ALLOWANCE);
    expect(await ensureWallet(db(), A, NOW + 3600)).toEqual({ started: false, allowance: false });
    expect(await ensureWallet(db(), A, NOW + 31 * 86400)).toEqual({ started: false, allowance: true });
    expect(await balance(db(), A)).toBe(START_COINS + 2 * MONTHLY_ALLOWANCE);
    await expect(ensureWallet(db(), OUT, NOW)).rejects.toMatchObject({ code: 'not_member' });
    expect((await ledger(db(), A)).map((r) => r.kind)).toEqual(['allowance', 'allowance', 'start']);
  });

  it('lets the board grant and take, and pays a purse once', async () => {
    expect(await grantCoins(db(), B, 40, A, 'Helped at the door', NOW)).toBe(START_COINS + MONTHLY_ALLOWANCE + 40);
    expect(await grantCoins(db(), B, -10, A, '', NOW)).toBe(START_COINS + MONTHLY_ALLOWANCE + 30);
    await expect(grantCoins(db(), B, 0, A, '', NOW)).rejects.toMatchObject({ code: 'bad_input' });
    expect(await payPurse(db(), eventId, [B, OUT], NOW)).toEqual([B]);
    expect(await payPurse(db(), eventId, [B], NOW + 1)).toEqual([]);
    expect(await balance(db(), B)).toBe(START_COINS + MONTHLY_ALLOWANCE + 30 + CHAMPION_PURSE);
  });

  it('runs a pool: bets while open, locked when closed, shared on settlement, undone on revert', async () => {
    const pool = ['t:1', 't:2', 't:3'];
    await expect(placeBet(db(), eventId, A, 't:1', 10, pool, null, NOW)).rejects.toMatchObject({ code: 'no_market' });
    expect(await openMarket(db(), eventId, NOW)).toBe(true);
    expect(await openMarket(db(), eventId, NOW)).toBe(false);
    await expect(placeBet(db(), eventId, A, 't:9', 10, pool, null, NOW)).rejects.toMatchObject({ code: 'missing' });
    await expect(placeBet(db(), eventId, A, 't:1', 2, pool, null, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(placeBet(db(), eventId, A, 't:1', 20, pool, 't:2', NOW)).rejects.toMatchObject({ code: 'bad_input' }); // A plays for team 2
    await expect(placeBet(db(), eventId, A, 't:1', 5000, pool, null, NOW)).rejects.toMatchObject({ code: 'poor' });
    await placeBet(db(), eventId, A, 't:1', 100, pool, null, NOW);
    await placeBet(db(), eventId, B, 't:2', 50, pool, null, NOW);
    await placeBet(db(), eventId, C, 't:1', 25, pool, null, NOW);
    // A changes their mind: the first stake comes back before the second goes out.
    const changed = await placeBet(db(), eventId, A, 't:1', 75, pool, null, NOW + 1);
    expect(changed.amount).toBe(75);
    expect(await balance(db(), A)).toBe(START_COINS + MONTHLY_ALLOWANCE - 75);
    const o = await odds(db(), eventId);
    expect(o.pool).toBe(150);
    expect(o.picks.map((p) => [p.pick, p.staked, p.backers])).toEqual([['t:1', 100, 2], ['t:2', 50, 1]]);
    expect(o.picks[0].multiplier).toBeCloseTo(1.5);
    // A redraw without team 2: Pekka's stake comes back.
    expect((await refundStaleBets(db(), eventId, ['t:1', 't:3'], NOW + 2)).map((b) => b.discord_id)).toEqual([B]);
    expect(await balance(db(), B)).toBe(START_COINS + MONTHLY_ALLOWANCE);
    await placeBet(db(), eventId, B, 't:3', 50, pool, null, NOW + 3);
    expect(await closeMarket(db(), eventId, NOW + 10)).toBe(true);
    await expect(placeBet(db(), eventId, A, 't:1', 10, pool, null, NOW + 11)).rejects.toMatchObject({ code: 'closed' });
    await expect(cancelBet(db(), eventId, A, NOW + 11)).rejects.toMatchObject({ code: 'closed' });
    expect(marketState(await getMarket(db(), eventId))).toBe('closed');
    // Team 1 wins: the 150 pool goes to Aino (75) and Kai (25) as 3:1.
    const settled = await settleMarket(db(), eventId, 't:1', NOW + 100);
    expect(settled?.refunded).toBe(false);
    expect(settled?.payouts.map((p) => [p.discord_id, p.payout])).toEqual([[A, 112], [C, 37]]);
    expect(await balance(db(), A)).toBe(START_COINS + MONTHLY_ALLOWANCE - 75 + 112);
    expect(await balance(db(), B)).toBe(START_COINS + MONTHLY_ALLOWANCE - 50);
    expect(await settleMarket(db(), eventId, 't:1', NOW + 101)).toBeNull();
    // The final is reverted: the winnings go back, the stakes stand.
    expect(await unsettleMarket(db(), eventId, NOW + 200)).toBe(true);
    expect(await balance(db(), A)).toBe(START_COINS + MONTHLY_ALLOWANCE - 75);
    expect(marketState(await getMarket(db(), eventId))).toBe('closed');
    expect(await reopenMarket(db(), eventId)).toBe(true);
    expect((await cancelBet(db(), eventId, A, NOW + 300))?.amount).toBe(75);
    expect(await balance(db(), A)).toBe(START_COINS + MONTHLY_ALLOWANCE);
    // Then team 3 wins instead: Pekka takes the whole pool of 75.
    await closeMarket(db(), eventId, NOW + 301);
    const again = await settleMarket(db(), eventId, 't:3', NOW + 302);
    expect(again?.payouts.map((p) => [p.discord_id, p.payout])).toEqual([[B, 75]]);
    // The leaderboard skips the hidden member.
    expect((await richest(db(), 5)).map((r) => r.username)).toEqual(['Pekka', 'Aino']);
  });

  it('gives everything back when nobody picked the champion', async () => {
    await openMarket(db(), eventId, NOW);
    await placeBet(db(), eventId, A, 't:1', 30, ['t:1', 't:2'], null, NOW);
    await placeBet(db(), eventId, B, 't:1', 20, ['t:1', 't:2'], null, NOW);
    const settled = await settleMarket(db(), eventId, 't:2', NOW + 5);
    expect(settled?.refunded).toBe(true);
    expect(await balance(db(), A)).toBe(START_COINS + MONTHLY_ALLOWANCE);
    expect(await balance(db(), B)).toBe(START_COINS + MONTHLY_ALLOWANCE);
  });
});

describe('activity income', () => {
  it('pays coins for season XP, the difference only, members only', async () => {
    const { payActivityCoins, balance: bal, COINS_PER_XP } = await import('../src/lib/coins');
    for (const t of ['coin_bets', 'coin_markets', 'coin_ledger', 'ticks', 'tick_kinds', 'events', 'register', 'members']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await member(A, 'Aino');
    await env.DB.prepare("INSERT INTO tick_kinds (name, description, sort, xp, season_cap, period, claimable, created_at) VALUES ('Helped', NULL, 1, 50, 0, 'season', 0, 1)").run();
    const kind = (await env.DB.prepare('SELECT id FROM tick_kinds').first<{ id: number }>())!.id;
    const reg = (await env.DB.prepare('SELECT id FROM register WHERE discord_id = ?1').bind(A).first<{ id: number }>())!.id;
    const give = (at: number) => env.DB.prepare('INSERT INTO ticks (kind_id, register_id, event_id, note, xp, given_by, given_at) VALUES (?1, ?2, NULL, NULL, 50, ?3, ?4)').bind(kind, reg, A, at).run();
    await give(NOW);
    expect(await payActivityCoins(env.DB, NOW + 10)).toBe(1);
    expect(await bal(env.DB, A)).toBe(50 * COINS_PER_XP);
    expect(await payActivityCoins(env.DB, NOW + 20)).toBe(0);
    await give(NOW + 30);
    expect(await payActivityCoins(env.DB, NOW + 40)).toBe(1);
    expect(await bal(env.DB, A)).toBe(100 * COINS_PER_XP);
  });
});
