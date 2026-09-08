// node scripts/gmail-token.mjs
//
// One-time: gets the refresh token that lets the site send mail as
// noreply@lahtiag.fi. Run it on your own machine, sign in as that account,
// and put the token it prints into the Worker with
//
//   npx wrangler secret put GMAIL_REFRESH_TOKEN
//
// Before it works, two things in the Google Cloud console, on the same
// OAuth client the register's sign-in already uses:
//   1. Authorized redirect URIs: add http://localhost:8975/oauth2
//   2. Data access: add the scope https://www.googleapis.com/auth/gmail.send
// Nothing in DNS changes: the domain's mail is already Google's, so what
// leaves carries the SPF and DKIM it always had.
//
// The token is printed once and never written to a file. Treat it the way
// you treat the client secret.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';

const REDIRECT = 'http://localhost:8975/oauth2';
const ask = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
};

const clientId = process.env.GOOGLE_CLIENT_ID || (await ask('Google OAuth client id: '));
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || (await ask('Google OAuth client secret: '));
if (!clientId || !clientSecret) {
  console.error('Both the client id and the secret are needed.');
  process.exit(1);
}

const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
url.searchParams.set('client_id', clientId);
url.searchParams.set('redirect_uri', REDIRECT);
url.searchParams.set('response_type', 'code');
url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send');
// Offline plus a forced consent is what makes Google hand over a refresh
// token: without them it gives an access token that dies in an hour.
url.searchParams.set('access_type', 'offline');
url.searchParams.set('prompt', 'consent');
url.searchParams.set('login_hint', process.env.GMAIL_SENDER ?? 'noreply@lahtiag.fi');

console.log('\nOpen this, signed in as the sending account:\n');
console.log(url.toString());
console.log('\nWaiting for the redirect on', REDIRECT, '…\n');

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const asked = new URL(req.url, REDIRECT);
    if (asked.pathname !== '/oauth2') {
      res.writeHead(404).end('no');
      return;
    }
    const got = asked.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(got ? 'Done. Close this tab and look at the terminal.' : 'No code came back.');
    server.close();
    got ? resolve(got) : reject(new Error(asked.searchParams.get('error') ?? 'no code'));
  });
  server.listen(8975, '127.0.0.1');
});

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});
const data = await response.json();
if (!response.ok || !data.refresh_token) {
  console.error('\nGoogle did not give a refresh token:', JSON.stringify(data, null, 2));
  console.error('\nIf it gave only an access token, the account has consented before: remove this app at');
  console.error('https://myaccount.google.com/permissions (as the sending account) and run this again.');
  process.exit(1);
}

console.log('\nRefresh token (put it in the Worker, then forget it):\n');
console.log(data.refresh_token);
console.log('\n  npx wrangler secret put GMAIL_REFRESH_TOKEN');
console.log('  npx wrangler secret put GMAIL_SENDER      # noreply@lahtiag.fi');
console.log('  npx wrangler secret put MAIL_REPLY_TO     # board@lahtiag.fi\n');
