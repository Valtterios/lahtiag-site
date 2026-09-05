import { describe, it, expect } from 'vitest';
import {
  sealBoard,
  openBoard,
  acceptGoogleUser,
  allowedBoardEmails,
  requireBoard,
  BOARD_COOKIE,
  BOARD_TTL_SECONDS,
} from '../src/lib/board';
import { sealSession, SESSION_COOKIE } from '../src/lib/auth';
import { env as testEnv } from 'cloudflare:test';
import { addRegisterAdmin, removeRegisterAdmin } from '../src/lib/db';

// The Google step-up in front of the register: the sealed board cookie,
// the account policy, and the gate that combines them.

const SECRET = 'board-test-secret';
const NOW = 1_760_000_000;
const ALLOW = 'Chair@lahtiag.fi, treasurer@lahtiag.fi ,,';

describe('board cookie', () => {
  it('round-trips and expires', async () => {
    const token = await sealBoard({ email: 'chair@lahtiag.fi', expiresAt: NOW + 10 }, SECRET);
    expect(await openBoard(token, SECRET, NOW)).toEqual({ email: 'chair@lahtiag.fi', expiresAt: NOW + 10 });
    expect(await openBoard(token, SECRET, NOW + 10)).toBeNull();
    expect(await openBoard(token, 'other-secret', NOW)).toBeNull();
    expect(await openBoard('garbage', SECRET, NOW)).toBeNull();
  });

  it('cannot be forged from a Discord session cookie sealed with the same secret', async () => {
    const discord = await sealSession(
      {
        discordId: '1',
        username: 'x',
        avatarHash: null,
        isAdmin: true,
        accessToken: 'tok',
        expiresAt: NOW + 1000,
      },
      SECRET,
    );
    expect(await openBoard(discord, SECRET, NOW)).toBeNull();
  });
});

describe('acceptGoogleUser', () => {
  it('parses the allowlist leniently', () => {
    expect(allowedBoardEmails(ALLOW)).toEqual(['chair@lahtiag.fi', 'treasurer@lahtiag.fi']);
    expect(allowedBoardEmails(undefined)).toEqual([]);
  });

  it('accepts a verified, in-domain, listed account (case-insensitively)', () => {
    expect(
      acceptGoogleUser({ email: 'Treasurer@LahtiAG.fi', email_verified: true, hd: 'lahtiag.fi' }, allowedBoardEmails(ALLOW)),
    ).toEqual({ ok: true, email: 'treasurer@lahtiag.fi' });
  });

  it('refuses unverified, foreign-domain, and unlisted accounts', () => {
    const list = allowedBoardEmails(ALLOW);
    expect(acceptGoogleUser({ email: 'chair@lahtiag.fi', email_verified: false, hd: 'lahtiag.fi' }, list)).toMatchObject({ reason: 'unverified' });
    expect(acceptGoogleUser({ email: 'chair@lahtiag.fi', email_verified: true }, list)).toMatchObject({ reason: 'wrong_domain' });
    expect(acceptGoogleUser({ email: 'chair@gmail.com', email_verified: true, hd: 'lahtiag.fi' }, list)).toMatchObject({ reason: 'wrong_domain' });
    expect(acceptGoogleUser({ email: 'secretary@lahtiag.fi', email_verified: true, hd: 'lahtiag.fi' }, list)).toMatchObject({ reason: 'not_allowed' });
  });
});

describe('requireBoard', () => {
  const env = { SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'cid', REGISTER_ADMINS: ALLOW };

  async function requestWith(email: string, cookieName = BOARD_COOKIE): Promise<Request> {
    const token = await sealBoard({ email, expiresAt: NOW + BOARD_TTL_SECONDS }, SECRET);
    return new Request('https://lahtiag.fi/register', { headers: { cookie: `${cookieName}=${token}` } });
  }

  it('is unconfigured without a client id or an allowlist', async () => {
    expect(await requireBoard(await requestWith('chair@lahtiag.fi'), { ...env, GOOGLE_CLIENT_ID: undefined }, NOW)).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await requireBoard(await requestWith('chair@lahtiag.fi'), { ...env, REGISTER_ADMINS: ' , ' }, NOW)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('needs the board cookie, not the Discord one', async () => {
    expect(await requireBoard(new Request('https://lahtiag.fi/register'), env, NOW)).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(await requireBoard(await requestWith('chair@lahtiag.fi', SESSION_COOKIE), env, NOW)).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(await requireBoard(await requestWith('chair@lahtiag.fi'), env, NOW)).toEqual({ ok: true, email: 'chair@lahtiag.fi' });
  });

  it('honours accounts added on the register page and their removal', async () => {
    await testEnv.DB.prepare('DELETE FROM register_admins').run();
    const withDb = { ...env, REGISTER_ADMINS: 'chair@lahtiag.fi', DB: testEnv.DB };
    const request = await requestWith('secretary@lahtiag.fi');
    expect(await requireBoard(request, withDb, NOW)).toEqual({ ok: false, reason: 'unauthenticated' });
    await addRegisterAdmin(testEnv.DB, ' Secretary@LahtiAG.fi ', 'chair@lahtiag.fi', NOW);
    expect(await requireBoard(request, withDb, NOW)).toEqual({ ok: true, email: 'secretary@lahtiag.fi' });
    expect(await removeRegisterAdmin(testEnv.DB, 'secretary@lahtiag.fi')).toBe(true);
    expect(await removeRegisterAdmin(testEnv.DB, 'secretary@lahtiag.fi')).toBe(false);
    expect(await requireBoard(request, withDb, NOW)).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('locks out an address removed from the allowlist even with a live cookie', async () => {
    const request = await requestWith('treasurer@lahtiag.fi');
    expect(await requireBoard(request, env, NOW)).toEqual({ ok: true, email: 'treasurer@lahtiag.fi' });
    expect(await requireBoard(request, { ...env, REGISTER_ADMINS: 'chair@lahtiag.fi' }, NOW)).toEqual({ ok: false, reason: 'unauthenticated' });
  });
});
