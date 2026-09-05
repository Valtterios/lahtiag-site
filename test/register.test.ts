import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  applyForMembership,
  decideApplication,
  updateRegisterEntry,
  setRegisterStatus,
  eraseRegisterEntry,
  listRegister,
  registerCounts,
  getRegisterEntry,
  getRegisterByDiscord,
  upsertMember,
  createEvent,
  setSignup,
  listSignups,
  requestDiscordLink,
  getPendingLinkByDiscord,
  listLinkRequests,
  resolveLinkRequest,
  setOwnActive,
  refreshLinkedDiscordName,
  listActiveRequests,
  setActive,
  createBoardEntry,
  findSimilarEntries,
  registerStats,
  listHousekeeping,
  HOUSEKEEPING,
  RuleError,
} from '../src/lib/db';
import {
  parseApplication,
  csvCell,
  deriveMemberType,
  searchKey,
  eligibilityWarning,
  sameHandle,
  type ApplicationInput,
} from '../src/lib/register';
import { applicationNotice } from '../src/lib/discord';

// The member register against the real schema (migration 0006): the
// uniqueness rules, the status transitions, search, and the link to event
// signups that shows the member mark.

const NOW = 1_760_000_000;
const db = () => env.DB;

async function wipe(): Promise<void> {
  for (const table of ['register', 'signups', 'event_teams', 'events', 'members']) {
    await db().prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(wipe);

function application(overrides: Partial<ApplicationInput> = {}): ApplicationInput {
  return {
    full_name: 'Aino Virtanen',
    domicile: 'Lahti',
    email: 'aino@example.com',
    student_status: 'LUT',
    union_member: 'LTKY',
    telegram: null,
    discord_name: null,
    games: 'Minecraft, Valorant',
    wants_active: false,
    message: null,
    ...overrides,
  };
}

const EXTRA_NONE = { discord_id: null, board_note: null, member_type: 'full' as const };
const EXTRA_FULL = { discord_id: null, board_note: null, member_type: 'full' as const };

function formOf(fields: Record<string, string | string[]>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) form.append(name, v);
  }
  return form;
}

const VALID_FORM = {
  full_name: '  Aino   Virtanen ',
  domicile: 'Lahti',
  email: 'Aino@Example.COM',
  student_status: 'LUT',
  union_member: 'LTKY',
  telegram: '@aino_v',
  discord_name: 'https://t.me/nope',
  games: ['Minecraft', 'Not a real game', 'Valorant', 'Minecraft'],
  games_other: 'Hades, Celeste',
  wants_active: 'on',
  message: 'Hi!',
  consent: 'on',
};

describe('parseApplication', () => {
  it('normalizes a valid form', () => {
    const parsed = parseApplication(formOf(VALID_FORM), true);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.full_name).toBe('Aino Virtanen');
    expect(parsed.value.email).toBe('aino@example.com');
    expect(parsed.value.telegram).toBe('aino_v');
    expect(parsed.value.discord_name).toBe('nope');
    // unknown games dropped, duplicates collapsed, "other" text appended with commas removed
    expect(parsed.value.games).toBe('Minecraft, Valorant, Hades  Celeste');
    expect(parsed.value.wants_active).toBe(true);
    expect(parsed.value.message).toBe('Hi!');
  });

  it('collects every failing field and requires consent on the public form', () => {
    const parsed = parseApplication(
      formOf({ ...VALID_FORM, full_name: 'A', email: 'not-an-email', student_status: 'MIT', consent: '' }),
      true,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.sort()).toEqual(['consent', 'email', 'full_name', 'student_status']);
  });

  it('does not require consent for the board edit form', () => {
    const { consent: _consent, ...withoutConsent } = VALID_FORM;
    expect(parseApplication(formOf(withoutConsent), false).ok).toBe(true);
    expect(parseApplication(formOf(withoutConsent), true).ok).toBe(false);
  });

  it('rejects over-long values instead of silently truncating', () => {
    const parsed = parseApplication(formOf({ ...VALID_FORM, full_name: 'x'.repeat(101) }), true);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toEqual(['full_name']);
  });
});

describe('applyForMembership', () => {
  it('stores a pending application and finds it by Discord id', async () => {
    const id = await applyForMembership(db(), application(), '1001', NOW);
    const entry = await getRegisterEntry(db(), id);
    expect(entry).toMatchObject({
      status: 'pending',
      source: 'web',
      member_type: 'full',
      discord_id: '1001',
      applied_at: NOW,
      consented_at: NOW,
      decided_at: null,
      wants_active: false,
    });
    expect((await getRegisterByDiscord(db(), '1001'))?.id).toBe(id);
    expect(await getRegisterByDiscord(db(), '9999')).toBeNull();
  });

  it('refuses a second application with the same email, case-insensitively', async () => {
    await applyForMembership(db(), application(), null, NOW);
    await expect(
      applyForMembership(db(), application({ email: 'AINO@example.com', full_name: 'Someone Else' }), null, NOW),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('refuses a second application from the same Discord account', async () => {
    await applyForMembership(db(), application(), '1001', NOW);
    await expect(
      applyForMembership(db(), application({ email: 'other@example.com' }), '1001', NOW),
    ).rejects.toMatchObject({ code: 'duplicate' });
    // ...but unlinked applications never clash on the missing id
    await applyForMembership(db(), application({ email: 'a@example.com' }), null, NOW);
    await applyForMembership(db(), application({ email: 'b@example.com' }), null, NOW);
  });
});

describe('member type', () => {
  it('derives full for LUT/LAB students and external for everyone else', () => {
    expect(deriveMemberType('LUT')).toBe('full');
    expect(deriveMemberType('LAB')).toBe('full');
    expect(deriveMemberType('alumni')).toBe('external');
    expect(deriveMemberType('other')).toBe('external');
  });

  it('is set on application and changeable by the board', async () => {
    const id = await applyForMembership(db(), application({ student_status: 'alumni' }), null, NOW);
    expect((await getRegisterEntry(db(), id))?.member_type).toBe('external');
    await updateRegisterEntry(db(), id, application({ student_status: 'alumni' }), { ...EXTRA_FULL, member_type: 'honorary' }, NOW);
    expect((await getRegisterEntry(db(), id))?.member_type).toBe('honorary');
  });
});

describe('decideApplication', () => {
  it('approve records who decided and when', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    await decideApplication(db(), id, 'approve', 'board-1', NOW + 100);
    expect(await getRegisterEntry(db(), id)).toMatchObject({
      status: 'member',
      decided_by: 'board-1',
      decided_at: NOW + 100,
    });
  });

  it('reject deletes the application outright', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    await decideApplication(db(), id, 'reject', 'board-1', NOW);
    expect(await getRegisterEntry(db(), id)).toBeNull();
  });

  it('only applies to pending entries', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    await decideApplication(db(), id, 'approve', 'board-1', NOW);
    await expect(decideApplication(db(), id, 'approve', 'board-1', NOW)).rejects.toMatchObject({
      code: 'missing',
    });
    await expect(decideApplication(db(), 404, 'reject', 'board-1', NOW)).rejects.toMatchObject({
      code: 'missing',
    });
  });
});

describe('updateRegisterEntry and status changes', () => {
  it('edits fields, links a Discord id and keeps a board note', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    await updateRegisterEntry(
      db(),
      id,
      application({ domicile: 'Hollola', wants_active: true }),
      { discord_id: '2002', board_note: 'Paid at the door', member_type: 'supporting' },
      NOW + 5,
    );
    expect(await getRegisterEntry(db(), id)).toMatchObject({
      domicile: 'Hollola',
      wants_active: true,
      discord_id: '2002',
      board_note: 'Paid at the door',
      member_type: 'supporting',
      updated_at: NOW + 5,
    });
  });

  it('refuses an edit that collides with another entry', async () => {
    const a = await applyForMembership(db(), application(), '1', NOW);
    const b = await applyForMembership(db(), application({ email: 'b@example.com' }), '2', NOW);
    await expect(
      updateRegisterEntry(db(), b, application({ email: 'aino@example.com' }), EXTRA_NONE, NOW),
    ).rejects.toMatchObject({ code: 'duplicate' });
    await expect(
      updateRegisterEntry(db(), b, application({ email: 'b@example.com' }), { ...EXTRA_NONE, discord_id: '1' }, NOW),
    ).rejects.toMatchObject({ code: 'duplicate' });
    // an entry may keep its own email and id
    await updateRegisterEntry(db(), a, application(), { ...EXTRA_NONE, discord_id: '1' }, NOW);
  });

  it('moves members to former and back, never a pending one', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    await expect(setRegisterStatus(db(), id, 'former', NOW)).rejects.toMatchObject({ code: 'missing' });
    await decideApplication(db(), id, 'approve', 'board-1', NOW);
    await setRegisterStatus(db(), id, 'former', NOW);
    expect((await getRegisterEntry(db(), id))?.status).toBe('former');
    await setRegisterStatus(db(), id, 'member', NOW);
    expect((await getRegisterEntry(db(), id))?.status).toBe('member');
  });

  it('erases and reports whether anything was there', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    expect(await eraseRegisterEntry(db(), id)).toBe(true);
    expect(await eraseRegisterEntry(db(), id)).toBe(false);
    expect(await getRegisterEntry(db(), id)).toBeNull();
  });
});

describe('listRegister and counts', () => {
  async function seed(): Promise<void> {
    const a = await applyForMembership(db(), application({ full_name: 'Aino Virtanen', telegram: 'aino_v' }), null, NOW);
    const b = await applyForMembership(db(), application({ full_name: 'Ben Ok', email: 'ben@example.com', discord_name: 'benny' }), null, NOW);
    await applyForMembership(db(), application({ full_name: 'Cara Pending', email: 'cara@example.com' }), null, NOW);
    await decideApplication(db(), a, 'approve', 'board', NOW);
    await decideApplication(db(), b, 'approve', 'board', NOW);
    await setRegisterStatus(db(), b, 'former', NOW);
  }

  it('orders pending first, filters by status, and counts', async () => {
    await seed();
    const all = await listRegister(db());
    expect(all.map((r) => r.full_name)).toEqual(['Cara Pending', 'Aino Virtanen', 'Ben Ok']);
    expect((await listRegister(db(), { status: 'former' })).map((r) => r.full_name)).toEqual(['Ben Ok']);
    expect(await registerCounts(db())).toEqual({ pending: 1, member: 1, former: 1 });
  });

  it('searches name, email and handles, treating % and _ literally', async () => {
    await seed();
    expect((await listRegister(db(), { q: 'virt' })).map((r) => r.full_name)).toEqual(['Aino Virtanen']);
    expect((await listRegister(db(), { q: 'ben@' })).map((r) => r.full_name)).toEqual(['Ben Ok']);
    expect((await listRegister(db(), { q: 'benny' })).map((r) => r.full_name)).toEqual(['Ben Ok']);
    expect((await listRegister(db(), { q: 'aino_v' })).map((r) => r.full_name)).toEqual(['Aino Virtanen']);
    expect(await listRegister(db(), { q: '%' })).toEqual([]);
    expect(await listRegister(db(), { q: 'a_no' })).toEqual([]);
  });
});

describe('linking an existing entry to Discord', () => {
  it('parks a request on the matching unlinked entry, silently otherwise', async () => {
    const id = await applyForMembership(db(), application(), null, NOW);
    expect(await requestDiscordLink(db(), 'nobody@example.com', '77', 'seven', NOW)).toBe('none');
    expect(await listLinkRequests(db())).toEqual([]);
    expect(await requestDiscordLink(db(), 'AINO@example.com', '77', 'seven', NOW + 1)).toBe('requested');
    expect(await getRegisterEntry(db(), id)).toMatchObject({
      link_discord_id: '77',
      link_discord_name: 'seven',
      link_requested_at: NOW + 1,
      discord_id: null,
    });
    expect((await getPendingLinkByDiscord(db(), '77'))?.id).toBe(id);
  });

  it('keeps one request per Discord account and none for linked accounts', async () => {
    const a = await applyForMembership(db(), application(), null, NOW);
    const b = await applyForMembership(db(), application({ email: 'b@example.com' }), null, NOW);
    await requestDiscordLink(db(), 'aino@example.com', '77', 'seven', NOW);
    await requestDiscordLink(db(), 'b@example.com', '77', 'seven', NOW);
    expect((await getRegisterEntry(db(), a))?.link_discord_id).toBeNull();
    expect((await getRegisterEntry(db(), b))?.link_discord_id).toBe('77');
    await applyForMembership(db(), application({ email: 'c@example.com' }), '88', NOW);
    expect(await requestDiscordLink(db(), 'aino@example.com', '88', 'eight', NOW)).toBe('none');
  });

  it('confirm links and records the handle; dismiss clears; both refuse when nothing is pending', async () => {
    const id = await applyForMembership(db(), application({ discord_name: 'old name' }), null, NOW);
    await expect(resolveLinkRequest(db(), id, 'confirm', NOW)).rejects.toMatchObject({ code: 'missing' });
    await requestDiscordLink(db(), 'aino@example.com', '77', 'seven', NOW);
    await resolveLinkRequest(db(), id, 'confirm', NOW + 5);
    expect(await getRegisterEntry(db(), id)).toMatchObject({
      discord_id: '77',
      discord_name: 'seven',
      link_discord_id: null,
      link_discord_name: null,
      updated_at: NOW + 5,
    });
    const other = await applyForMembership(db(), application({ email: 'o@example.com' }), null, NOW);
    await requestDiscordLink(db(), 'o@example.com', '99', 'nine', NOW);
    await resolveLinkRequest(db(), other, 'dismiss', NOW);
    expect(await getRegisterEntry(db(), other)).toMatchObject({ discord_id: null, link_discord_id: null });
  });

  it('confirm refuses when that Discord account got linked elsewhere meanwhile', async () => {
    const a = await applyForMembership(db(), application(), null, NOW);
    await requestDiscordLink(db(), 'aino@example.com', '77', 'seven', NOW);
    await applyForMembership(db(), application({ email: 'z@example.com' }), '77', NOW);
    await expect(resolveLinkRequest(db(), a, 'confirm', NOW)).rejects.toMatchObject({ code: 'duplicate' });
  });
});

describe('self-service actives flag', () => {
  it('updates the linked entry only, as a request until the board approves', async () => {
    expect(await setOwnActive(db(), '77', true, 'me', NOW)).toBeNull();
    const id = await applyForMembership(db(), application(), '77', NOW);
    await decideApplication(db(), id, 'approve', 'board', NOW);
    const updated = await setOwnActive(db(), '77', true, 'aino_tg', NOW + 9);
    expect(updated).toMatchObject({ id, wants_active: true, is_active: false, telegram: 'aino_tg', updated_at: NOW + 9 });
    expect(await listRegister(db(), { activesOnly: true })).toEqual([]);
    await setActive(db(), id, true, 'chair', NOW + 10);
    expect((await listRegister(db(), { activesOnly: true })).map((r) => r.id)).toEqual([id]);
    await setOwnActive(db(), '77', false, null, NOW + 11);
    expect(await listRegister(db(), { activesOnly: true })).toEqual([]);
  });
});

describe('accent-insensitive search', () => {
  it('normalizes keys and finds Finnish names typed without umlauts', async () => {
    expect(searchKey(['Äijö', null, 'Östberg'])).toBe('aijo ostberg');
    const id = await applyForMembership(db(), application({ full_name: 'Väinö Äijö' }), null, NOW);
    expect((await listRegister(db(), { q: 'aijo' })).map((r) => r.id)).toEqual([id]);
    expect((await listRegister(db(), { q: 'ÄIJÖ' })).map((r) => r.id)).toEqual([id]);
    await updateRegisterEntry(db(), id, application({ full_name: 'Väinö Öhman' }), EXTRA_NONE, NOW);
    expect(await listRegister(db(), { q: 'aijo' })).toEqual([]);
    expect((await listRegister(db(), { q: 'ohman' })).map((r) => r.id)).toEqual([id]);
  });
});

describe('board-created entries', () => {
  it('records the board as the source and decider, and enforces uniqueness', async () => {
    const id = await createBoardEntry(
      db(),
      application({ full_name: 'Honor Person', email: 'h@example.com', student_status: 'other' }),
      { member_type: 'honorary', status: 'member', discord_id: null, board_note: 'Invited 2026' },
      'chair@lahtiag.fi',
      NOW,
    );
    expect(await getRegisterEntry(db(), id)).toMatchObject({
      source: 'board',
      status: 'member',
      member_type: 'honorary',
      decided_by: 'chair@lahtiag.fi',
      decided_at: NOW,
      consented_at: NOW,
      board_note: 'Invited 2026',
    });
    const pending = await createBoardEntry(
      db(),
      application({ email: 'p@example.com' }),
      { member_type: 'full', status: 'pending', discord_id: null, board_note: null },
      'chair@lahtiag.fi',
      NOW,
    );
    expect(await getRegisterEntry(db(), pending)).toMatchObject({ status: 'pending', decided_at: null, decided_by: null });
    await expect(
      createBoardEntry(db(), application({ email: 'H@example.com' }), { member_type: 'full', status: 'member', discord_id: null, board_note: null }, 'x', NOW),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });
});

describe('hints for the board', () => {
  it('warns when a LUT/LAB claim comes without a student address', () => {
    expect(eligibilityWarning({ student_status: 'LUT', email: 'a@student.lut.fi' })).toBeNull();
    expect(eligibilityWarning({ student_status: 'LAB', email: 'a@LAB.fi' })).toBeNull();
    expect(eligibilityWarning({ student_status: 'LUT', email: 'a@gmail.com' })).toMatch(/LUT/);
    expect(eligibilityWarning({ student_status: 'alumni', email: 'a@gmail.com' })).toBeNull();
  });

  it('finds entries with the same surname or email local part', async () => {
    const a = await applyForMembership(db(), application({ full_name: 'Aino Virtanen', email: 'aino.v@example.com' }), null, NOW);
    const b = await applyForMembership(db(), application({ full_name: 'Aino Virtanen', email: 'aino.v@other.example' }), null, NOW);
    const c = await applyForMembership(db(), application({ full_name: 'Bo Virtanen', email: 'bo@example.com' }), null, NOW);
    await applyForMembership(db(), application({ full_name: 'Cara Nieminen', email: 'cara@example.com' }), null, NOW);
    const similar = await findSimilarEntries(db(), { id: b, full_name: 'Aino Virtanen', email: 'aino.v@other.example' });
    expect(similar.map((r) => r.id).sort()).toEqual([a, c].sort());
    expect(await findSimilarEntries(db(), { id: 999, full_name: 'X', email: 'x@y.z' })).toEqual([]);
  });
});

describe('numbers and housekeeping', () => {
  it('counts current members by class, school and year, plus actives', async () => {
    const a = await applyForMembership(db(), application({ wants_active: true }), null, NOW);
    const b = await applyForMembership(db(), application({ email: 'b@example.com', student_status: 'alumni' }), null, NOW);
    await applyForMembership(db(), application({ email: 'c@example.com', wants_active: true }), null, NOW);
    await decideApplication(db(), a, 'approve', 'x', NOW);
    await decideApplication(db(), b, 'approve', 'x', NOW + 366 * 86400);
    expect((await registerStats(db())).actives).toBe(0);
    await setActive(db(), a, true, 'chair', NOW);
    const stats = await registerStats(db());
    expect(stats.actives).toBe(1);
    expect(stats.membersByType).toEqual({ full: 1, external: 1, supporting: 0, honorary: 0 });
    expect(stats.membersBySchool).toEqual({ LUT: 1, LAB: 0, alumni: 1, other: 0 });
    expect(stats.joinedByYear).toEqual([
      { year: '2025', n: 1 },
      { year: '2026', n: 1 },
    ]);
  });

  it('lists stale pending applications and long-former members', async () => {
    const stale = await applyForMembership(db(), application(), null, NOW - (HOUSEKEEPING.pendingAfterDays + 1) * 86400);
    await applyForMembership(db(), application({ email: 'fresh@example.com' }), null, NOW);
    const old = await applyForMembership(db(), application({ email: 'old@example.com' }), null, NOW - 800 * 86400);
    await decideApplication(db(), old, 'approve', 'x', NOW - 800 * 86400);
    await setRegisterStatus(db(), old, 'former', NOW - (HOUSEKEEPING.formerAfterDays + 1) * 86400);
    const recent = await applyForMembership(db(), application({ email: 'recent@example.com' }), null, NOW);
    await decideApplication(db(), recent, 'approve', 'x', NOW);
    await setRegisterStatus(db(), recent, 'former', NOW);
    expect((await listHousekeeping(db(), NOW)).map((r) => r.id).sort()).toEqual([stale, old].sort());
  });
});

describe('Discord names over time', () => {
  it('compares handles the way people type them', () => {
    expect(sameHandle('Aino_V', '@aino_v')).toBe(true);
    expect(sameHandle('aino_v#1234', 'aino_v')).toBe(true);
    expect(sameHandle('aino_v', 'aino')).toBe(false);
    expect(sameHandle(null, 'aino')).toBe(false);
    expect(sameHandle('', '')).toBe(false);
  });

  it('refreshes the stored name of a linked entry on sign-in, and only then', async () => {
    const id = await applyForMembership(db(), application({ discord_name: 'oldname' }), '77', NOW);
    await refreshLinkedDiscordName(db(), '77', 'newname', NOW + 1);
    expect(await getRegisterEntry(db(), id)).toMatchObject({ discord_name: 'newname', updated_at: NOW + 1 });
    expect((await listRegister(db(), { q: 'newname' })).map((r) => r.id)).toEqual([id]);
    await refreshLinkedDiscordName(db(), '99', 'stranger', NOW + 2);
    expect((await getRegisterEntry(db(), id))?.updated_at).toBe(NOW + 1);
  });
});

describe('actives: request, decision, leaving', () => {
  async function member(email: string, discordId: string | null, wants = false): Promise<number> {
    const id = await applyForMembership(db(), application({ email, wants_active: wants }), discordId, NOW);
    await decideApplication(db(), id, 'approve', 'board', NOW);
    return id;
  }

  it('lists requests from members only, and approval records who and when', async () => {
    const a = await member('a@example.com', '1', true);
    await applyForMembership(db(), application({ email: 'p@example.com', wants_active: true }), '2', NOW); // pending, not listed
    await member('b@example.com', '3', false);
    expect((await listActiveRequests(db())).map((r) => r.id)).toEqual([a]);
    const approved = await setActive(db(), a, true, 'chair@lahtiag.fi', NOW + 5);
    expect(approved).toMatchObject({ is_active: true, wants_active: true, active_since: NOW + 5, active_by: 'chair@lahtiag.fi' });
    expect(await listActiveRequests(db())).toEqual([]);
    expect((await registerStats(db())).actives).toBe(1);
    expect((await listRegister(db(), { activesOnly: true })).map((r) => r.id)).toEqual([a]);
  });

  it('decline and revoke clear both the approval and the request', async () => {
    const a = await member('a@example.com', '1', true);
    await setActive(db(), a, false, 'chair', NOW);
    expect(await getRegisterEntry(db(), a)).toMatchObject({ is_active: false, wants_active: false, active_since: null });
    await expect(setActive(db(), 404, true, 'chair', NOW)).rejects.toMatchObject({ code: 'missing' });
  });

  it('a member unticking the box leaves the actives; re-ticking asks again', async () => {
    const a = await member('a@example.com', '1', true);
    await setActive(db(), a, true, 'chair', NOW);
    const left = await setOwnActive(db(), '1', false, null, NOW + 1);
    expect(left).toMatchObject({ is_active: false, wants_active: false, active_since: null });
    const asked = await setOwnActive(db(), '1', true, 'tg', NOW + 2);
    expect(asked).toMatchObject({ is_active: false, wants_active: true, telegram: 'tg' });
    expect((await listActiveRequests(db())).map((r) => r.id)).toEqual([a]);
    // ticking again while active changes nothing about the approval
    await setActive(db(), a, true, 'chair', NOW + 3);
    expect(await setOwnActive(db(), '1', true, 'tg', NOW + 4)).toMatchObject({ is_active: true, active_since: NOW + 3 });
  });

  it('becoming a former member ends being an active', async () => {
    const a = await member('a@example.com', '1', true);
    await setActive(db(), a, true, 'chair', NOW);
    await setRegisterStatus(db(), a, 'former', NOW + 1);
    expect(await getRegisterEntry(db(), a)).toMatchObject({ status: 'former', is_active: false, wants_active: false });
  });
});

describe('member mark on event signups', () => {
  it('flags signups whose Discord account is linked to a current member', async () => {
    for (const id of ['admin', 'linked', 'former', 'stranger']) {
      await upsertMember(db(), { discord_id: id, username: id, avatar_hash: null }, NOW);
    }
    const eventId = await createEvent(
      db(),
      { title: 'LAN', description: null, starts_at: NOW + 3600, capacity: null, created_by: 'admin' },
      NOW,
    );
    const linked = await applyForMembership(db(), application(), 'linked', NOW);
    await decideApplication(db(), linked, 'approve', 'admin', NOW);
    const former = await applyForMembership(db(), application({ email: 'f@example.com' }), 'former', NOW);
    await decideApplication(db(), former, 'approve', 'admin', NOW);
    await setRegisterStatus(db(), former, 'former', NOW);
    for (const id of ['linked', 'former', 'stranger']) await setSignup(db(), eventId, id, 'yes', NOW);

    const marks = Object.fromEntries((await listSignups(db(), eventId)).map((s) => [s.discord_id, s.is_member]));
    expect(marks).toEqual({ linked: 1, former: 0, stranger: 0 });
  });
});

describe('csvCell', () => {
  it('neutralizes formulas and quotes separators', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@me')).toBe("'@me");
    expect(csvCell('Virtanen, Aino')).toBe('"Virtanen, Aino"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
    expect(csvCell(7)).toBe('7');
  });
});

describe('applicationNotice', () => {
  it('keeps applicant-supplied text out of Discord markdown', () => {
    const text = applicationNotice({
      name: '@everyone [click](https://evil.example) `x`\nmore',
      studentStatus: 'LUT University',
      url: 'https://lahtiag.fi/register',
    });
    expect(text).toContain('`@everyone [click](https://evil.example) xmore`');
    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('RuleError codes', () => {
  it('exposes duplicate as a code the routes can redirect on', () => {
    expect(new RuleError('duplicate', 'x').code).toBe('duplicate');
  });
});
