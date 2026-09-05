// Google's side of the register sign-in: the OpenID Connect authorization
// code flow, server-side. Only three calls exist: build the authorize URL,
// trade the code for tokens, ask who the account is. Policy (domain,
// allowlist) lives in board.ts.

import { WORKSPACE_DOMAIN, type GoogleUser } from './board';

export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  // Account chooser hint only; the hd claim is verified after sign-in.
  url.searchParams.set('hd', WORKSPACE_DOMAIN);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

// The tokens came straight from Google's token endpoint over TLS with our
// client secret, so the userinfo answer is trustworthy without verifying
// the id_token signature ourselves.
export async function fetchGoogleUser(accessToken: string): Promise<GoogleUser | null> {
  try {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as GoogleUser;
  } catch {
    return null;
  }
}
