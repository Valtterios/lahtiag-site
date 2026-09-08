import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// Swapping two register ids. The id is the member number on the card, and
// two tables carry it as a foreign key with enforcement on, so the parent
// cannot move while a child points at it. The rehearsal for doing this to
// the real register lives here rather than in a comment.

const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['tick_claims', 'ticks', 'tick_kinds', 'register']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

async function person(id: number, name: string): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO register (id, full_name, domicile, email, student_status, union_member, member_type, status, source, applied_at, consented_at, updated_at, search_key)
       VALUES (?1, ?2, 'Lahti', ?3, 'LUT', 'LTKY', 'full', 'member', 'board', 1, 1, 1, ?2)`,
    )
    .bind(id, name, `${name}@example.com`)
    .run();
}

// Exactly the statements run against the register, in order.
function steps(a: number, b: number, park: number): string[] {
  return [
    'PRAGMA defer_foreign_keys = ON',
    `UPDATE ticks SET register_id = ${park} WHERE register_id = ${a}`,
    `UPDATE tick_claims SET register_id = ${park} WHERE register_id = ${a}`,
    `UPDATE register SET id = ${park} WHERE id = ${a}`,
    `UPDATE ticks SET register_id = ${a} WHERE register_id = ${b}`,
    `UPDATE tick_claims SET register_id = ${a} WHERE register_id = ${b}`,
    `UPDATE register SET id = ${a} WHERE id = ${b}`,
    `UPDATE ticks SET register_id = ${b} WHERE register_id = ${park}`,
    `UPDATE tick_claims SET register_id = ${b} WHERE register_id = ${park}`,
    `UPDATE register SET id = ${b} WHERE id = ${park}`,
  ];
}

beforeEach(wipe);

describe('swapping two register ids', () => {
  it('carries the ticks and the claims with them', async () => {
    await person(1, 'Toivo');
    await person(2, 'Valtteri');
    await person(3, 'Someone');
    const kind = await db()
      .prepare("INSERT INTO tick_kinds (name, created_at) VALUES ('Helped', 1) RETURNING id")
      .first<{ id: number }>();
    await db().prepare('INSERT INTO ticks (kind_id, register_id, note, xp, given_by, given_at) VALUES (?1, 2, NULL, 100, ?2, 1)').bind(kind!.id, 'a@b.c').run();
    await db().prepare("INSERT INTO tick_claims (kind_id, register_id, discord_id, status, created_at) VALUES (?1, 1, '9', 'pending', 1)").bind(kind!.id).run();

    // One batch, so D1 runs it as a single transaction and the deferred
    // foreign keys are only checked once, at the end.
    await db().batch(steps(2, 1, 900_001).map((sql) => db().prepare(sql)));

    const rows = await db().prepare('SELECT id, full_name FROM register ORDER BY id').all<{ id: number; full_name: string }>();
    expect(rows.results.map((r) => [r.id, r.full_name])).toEqual([
      [1, 'Valtteri'],
      [2, 'Toivo'],
      [3, 'Someone'],
    ]);
    // The tick followed Valtteri from 2 to 1; the claim followed Toivo to 2.
    const tick = await db().prepare('SELECT register_id FROM ticks').first<{ register_id: number }>();
    const claim = await db().prepare('SELECT register_id FROM tick_claims').first<{ register_id: number }>();
    expect(tick!.register_id).toBe(1);
    expect(claim!.register_id).toBe(2);
    // Nothing parked and forgotten.
    const stray = await db().prepare('SELECT COUNT(*) AS n FROM register WHERE id > 900000').first<{ n: number }>();
    expect(stray!.n).toBe(0);
  });
});
