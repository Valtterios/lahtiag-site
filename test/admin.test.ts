import { describe, it, expect } from 'vitest';
import { signSession, sessionCookie, SESSION_TTL_SECONDS } from '../src/lib/auth';
import { requireAdmin } from '../src/lib/guard';
import { hasAdminRole, type GuildMembership } from '../src/lib/discord';

// The demoted-admin case (spec, Authentication): the stateless cookie keeps
// is_admin until expiry, so writes must re-ask Discord. These tests feed
// requireAdmin a cookie that still claims admin and a Discord answer that
// says otherwise.

const SECRET = 'guard-test-secret';
const ADMIN_ROLE = '555000555';
const env = { SESSION_SECRET: SECRET, ADMIN_ROLE_ID: ADMIN_ROLE };

async function requestWithSession(isAdmin: boolean): Promise<Request> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signSession(
    {
      discordId: '42',
      username: 'demoted',
      avatarHash: null,
      isAdmin,
      accessToken: 'tok',
      expiresAt: now + SESSION_TTL_SECONDS,
    },
    SECRET,
  );
  // sessionCookie() is a Set-Cookie value; its first pair is the cookie.
  return new Request('https://lahtiag.fi/events/new', {
    headers: { cookie: sessionCookie(token).split(';')[0] },
  });
}

const answer = (membership: GuildMembership) => async () => membership;

describe('requireAdmin', () => {
  it('rejects a request with no session', async () => {
    const result = await requireAdmin(new Request('https://lahtiag.fi/'), env, answer({ status: 'member', roles: [ADMIN_ROLE], nick: null }));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('accepts when Discord still confirms the role', async () => {
    const result = await requireAdmin(
      await requestWithSession(true),
      env,
      answer({ status: 'member', roles: ['1', ADMIN_ROLE], nick: null }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a demoted admin even though the cookie still says is_admin', async () => {
    const result = await requireAdmin(
      await requestWithSession(true),
      env,
      answer({ status: 'member', roles: ['1', '2'], nick: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('rejects someone who left the server entirely', async () => {
    const result = await requireAdmin(await requestWithSession(true), env, answer({ status: 'not_member' }));
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('distinguishes Discord being unreachable from a denial', async () => {
    const result = await requireAdmin(await requestWithSession(true), env, answer({ status: 'error' }));
    expect(result).toEqual({ ok: false, reason: 'discord_down' });
  });
});

describe('hasAdminRole placeholder', () => {
  it('fails closed on the "0" placeholder and the empty string', () => {
    expect(hasAdminRole(['0'], '0')).toBe(false);
    expect(hasAdminRole([''], '')).toBe(false);
    expect(hasAdminRole([ADMIN_ROLE], ADMIN_ROLE)).toBe(true);
  });
});
