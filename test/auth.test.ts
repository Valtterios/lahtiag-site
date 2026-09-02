import { describe, it, expect } from 'vitest';
import {
  signSession,
  verifySession,
  readCookie,
  csrfMatches,
  type Session,
} from '../src/lib/auth';

const SECRET = 'test-secret-of-reasonable-length';
const NOW = 1_760_000_000;

function sampleSession(overrides: Partial<Session> = {}): Session {
  return {
    discordId: '123456789',
    username: 'Testaaja',
    avatarHash: 'abc123',
    isAdmin: false,
    accessToken: 'tok_x',
    expiresAt: NOW + 3600,
    ...overrides,
  };
}

describe('session cookie', () => {
  it('round-trips through sign and verify', async () => {
    const token = await signSession(sampleSession(), SECRET);
    const session = await verifySession(token, SECRET, NOW);
    expect(session).not.toBeNull();
    expect(session!.discordId).toBe('123456789');
    expect(session!.isAdmin).toBe(false);
  });

  it('rejects an expired session', async () => {
    const token = await signSession(sampleSession({ expiresAt: NOW - 1 }), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  it('rejects exactly-at-expiry as expired', async () => {
    const token = await signSession(sampleSession({ expiresAt: NOW }), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signSession(sampleSession(), SECRET);
    // Flip one character inside the payload half.
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(await verifySession(tampered, SECRET, NOW)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signSession(sampleSession(), SECRET);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(await verifySession(tampered, SECRET, NOW)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(sampleSession(), 'some-other-secret');
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  it.each(['', 'no-dot', 'a.b', '..', '%%%.%%%'])('rejects malformed input %j', async (bad) => {
    expect(await verifySession(bad, SECRET, NOW)).toBeNull();
  });

  it('preserves the admin flag through the round-trip', async () => {
    const token = await signSession(sampleSession({ isAdmin: true }), SECRET);
    expect((await verifySession(token, SECRET, NOW))!.isAdmin).toBe(true);
  });
});

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    expect(readCookie('a=1; __Host-session=xyz; b=2', '__Host-session')).toBe('xyz');
  });

  it('returns null when absent or header missing', () => {
    expect(readCookie('a=1', '__Host-session')).toBeNull();
    expect(readCookie(null, '__Host-session')).toBeNull();
  });
});

describe('csrfMatches', () => {
  it('accepts equal tokens and rejects everything else', async () => {
    expect(await csrfMatches('tok', 'tok')).toBe(true);
    expect(await csrfMatches('tok', 'other')).toBe(false);
    expect(await csrfMatches('tok', null)).toBe(false);
    expect(await csrfMatches('', '')).toBe(false);
  });
});
