import { describe, it, expect } from 'vitest';
import { GET } from '../src/pages/dc';
import { DISCORD_INVITE } from '../src/lib/config';

// lahtiag.fi/dc: the short way into the Discord.

describe('/dc', () => {
  it('sends visitors to the invite, temporarily so it can be changed', () => {
    const redirect = (url: string, status: number) => new Response(null, { status, headers: { location: url } });
    const response = GET({ redirect } as never) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(DISCORD_INVITE);
    expect(DISCORD_INVITE.startsWith('https://discord.com/invite/')).toBe(true);
  });
});
