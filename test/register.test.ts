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
  RuleError,
} from '../src/lib/db';
import { parseApplication, csvCell, deriveMemberType, type ApplicationInput } from '../src/lib/register';
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
