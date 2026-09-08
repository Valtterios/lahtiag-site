import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  applyForMembership,
  askForCorrection,
  clearCorrection,
  createEditLink,
  entryByEditToken,
  updateEntryByToken,
  editLinkStatus,
  decideApplication,
  getRegisterEntry,
  EDIT_LINK_DAYS,
} from '../src/lib/db';
import type { ApplicationInput } from '../src/lib/register';

// The private link: the only way into somebody's own entry that does not
// go through an account, so what matters is that it opens exactly one
// entry, dies on its own, and cannot be reconstructed from the database.

const NOW = 1_760_000_000;
const db = () => env.DB;

const application = (over: Partial<ApplicationInput> = {}): ApplicationInput => ({
  full_name: 'Nina',
  domicile: 'Lahti',
  email: 'nina@example.fi',
  student_status: 'LUT',
  union_member: 'LTKY',
  telegram: null,
  discord_name: null,
  games: 'Minecraft',
  wants_active: false,
  message: null,
  ...over,
});

describe('the private link', () => {
  beforeEach(async () => {
    for (const table of ['register_edit_links', 'register', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
  });

  it('opens one entry, answers the board, and keeps working for a fortnight', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    await askForCorrection(db(), id, 'We need your surname.', 'chair@lahtiag.fi', NOW);
    const token = await createEditLink(db(), id, 'chair@lahtiag.fi', NOW);
    expect(token.length).toBeGreaterThan(20);

    // The token is not in the database; only its hash is.
    const stored = await db().prepare('SELECT token_hash, expires_at FROM register_edit_links').first<{ token_hash: string; expires_at: number }>();
    expect(stored!.token_hash).not.toContain(token);
    expect(stored!.token_hash).toHaveLength(64);
    expect(stored!.expires_at).toBe(NOW + EDIT_LINK_DAYS * 86400);

    expect((await entryByEditToken(db(), token, NOW))?.id).toBe(id);
    expect(await entryByEditToken(db(), 'not-a-real-token-at-all', NOW)).toBeNull();
    expect(await entryByEditToken(db(), '', NOW)).toBeNull();

    // Saving through it is the same answer as saving on the membership page.
    const saved = await updateEntryByToken(db(), token, application({ full_name: 'Nina Korhonen' }), NOW + 60);
    expect(saved).toMatchObject({ full_name: 'Nina Korhonen', fix_note: null, status: 'pending' });
    expect((await editLinkStatus(db(), id))?.used_at).toBe(NOW + 60);
    // …and it still works afterwards: one correction can need two goes.
    expect((await entryByEditToken(db(), token, NOW + 120))?.id).toBe(id);

    // A fortnight later it is nothing.
    expect(await entryByEditToken(db(), token, NOW + EDIT_LINK_DAYS * 86400 + 1)).toBeNull();
  });

  it('is replaced by the next one, withdrawn with the question, and gone once decided', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    const first = await createEditLink(db(), id, 'chair@lahtiag.fi', NOW);
    const second = await createEditLink(db(), id, 'chair@lahtiag.fi', NOW + 10);
    expect(await entryByEditToken(db(), first, NOW + 20)).toBeNull(); // a link that went astray stops working
    expect((await entryByEditToken(db(), second, NOW + 20))?.id).toBe(id);

    await clearCorrection(db(), id, NOW + 30);
    await db().prepare('DELETE FROM register_edit_links WHERE register_id = ?1').bind(id).run();
    expect(await editLinkStatus(db(), id)).toBeNull();

    const third = await createEditLink(db(), id, 'chair@lahtiag.fi', NOW + 40);
    await decideApplication(db(), id, 'approve', 'chair@lahtiag.fi', NOW + 50);
    expect(await entryByEditToken(db(), third, NOW + 60)).toBeNull();
    expect((await getRegisterEntry(db(), id))?.status).toBe('member');
  });

  it('refuses an email another entry already has, and leaves the entry as it was', async () => {
    const mine = await applyForMembership(db(), application(), null, NOW);
    await applyForMembership(db(), application({ email: 'taken@example.fi', full_name: 'Someone Else' }), null, NOW);
    const token = await createEditLink(db(), mine, 'chair@lahtiag.fi', NOW);
    await expect(updateEntryByToken(db(), token, application({ email: 'taken@example.fi' }), NOW + 5)).rejects.toMatchObject({ code: 'duplicate' });
    expect((await getRegisterEntry(db(), mine))?.email).toBe('nina@example.fi');
  });
});
