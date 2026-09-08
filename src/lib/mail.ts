// Email from the association's own Google Workspace, for the people the
// site cannot reach any other way — an applicant who joined without
// Discord, chiefly.
//
// Gmail's API rather than SMTP, which a Worker cannot speak, and rather
// than an outside sender: the domain's mail is already Google's, so
// nothing has to be added to DNS and every message leaves with the SPF
// and DKIM the domain already has. One account does the sending
// (noreply@), and its refresh token is a Worker secret — the same OAuth
// client the register's sign-in uses, since a refresh token is granted to
// an account rather than borrowed from one.

export interface MailEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GMAIL_SENDER?: string; // noreply@lahtiag.fi
  GMAIL_REFRESH_TOKEN?: string;
  MAIL_REPLY_TO?: string; // where an answer should go: board@lahtiag.fi
}

export function mailConfigured(env: MailEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GMAIL_SENDER && env.GMAIL_REFRESH_TOKEN);
}

// A header value with anything but ASCII in it is encoded the way mail
// has always encoded such things (RFC 2047), so a Finnish name in a
// subject line survives whatever is between here and the inbox.
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(clean)))}?=`;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Letter {
  to: string;
  subject: string;
  text: string;
}

// The message itself: plain text, UTF-8, base64 body — a body encoded
// this way cannot be broken by a long line or a bare newline on the way.
export function mailMessage(from: string, letter: Letter, replyTo?: string): string {
  const body = new TextEncoder().encode(letter.text.replace(/\r?\n/g, '\r\n'));
  const encoded = btoa(String.fromCharCode(...body)).replace(/(.{76})/g, '$1\r\n');
  const headers = [
    `From: ${encodeHeader('LahtiAG')} <${from}>`,
    `To: ${letter.to.replace(/[\r\n]/g, '')}`,
    ...(replyTo ? [`Reply-To: <${replyTo}>`] : []),
    `Subject: ${encodeHeader(letter.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${encoded}`;
}

// A refresh token is long-lived and an access token is not; this trades
// one for the other on every send, which is a single request and saves
// keeping any state.
async function accessToken(env: MailEnv): Promise<string | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        refresh_token: env.GMAIL_REFRESH_TOKEN!,
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) {
      console.log(`mail: the refresh token was refused (${response.status})`);
      return null;
    }
    return ((await response.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

// Best effort, like every other message the site sends: a letter that
// cannot go says so in the log and never fails the click behind it.
export async function sendMail(env: MailEnv, letter: Letter): Promise<boolean> {
  if (!mailConfigured(env)) return false;
  const token = await accessToken(env);
  if (!token) return false;
  try {
    const raw = base64url(new TextEncoder().encode(mailMessage(env.GMAIL_SENDER!, letter, env.MAIL_REPLY_TO)));
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!response.ok) console.log(`mail: Gmail refused the message (${response.status})`);
    return response.ok;
  } catch {
    return false;
  }
}
