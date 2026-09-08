import { describe, it, expect } from 'vitest';
import { mailMessage, encodeHeader, base64url, mailConfigured } from '../src/lib/mail';

// The letter itself, which is the part that has to be right before
// anything is sent: headers a mail server will accept, a body that
// survives a Finnish name, and nothing sent at all until the account
// behind it exists.

const decode = (message: string): string => {
  const body = message.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '');
  return new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
};

describe('the letter', () => {
  it('addresses, signs and encodes it', () => {
    const message = mailMessage('noreply@lahtiag.fi', { to: 'nina@example.fi', subject: 'Your application', text: 'Hello.' }, 'board@lahtiag.fi');
    expect(message).toContain('From: LahtiAG <noreply@lahtiag.fi>');
    expect(message).toContain('To: nina@example.fi');
    expect(message).toContain('Reply-To: <board@lahtiag.fi>');
    expect(message).toContain('Subject: Your application');
    expect(message).toContain('Content-Type: text/plain; charset="UTF-8"');
    // headers, a blank line, then the body — the shape every mail server expects
    expect(message.split('\r\n\r\n')).toHaveLength(2);
    expect(decode(message)).toBe('Hello.');
  });

  it('carries Finnish through the subject and the body', () => {
    const message = mailMessage('noreply@lahtiag.fi', { to: 'a@b.fi', subject: 'Jäsenhakemuksesi — Östberg', text: 'Terve Väinö,\n\nkotikunta puuttuu.\n' });
    expect(message).toContain('Subject: =?UTF-8?B?');
    expect(message).not.toContain('Reply-To');
    expect(decode(message)).toBe('Terve Väinö,\r\n\r\nkotikunta puuttuu.\r\n');
    expect(encodeHeader('plain ascii')).toBe('plain ascii');
    // A header cannot be made to hold a second header.
    expect(encodeHeader('one\r\nBcc: someone@else.fi')).toBe('one Bcc: someone@else.fi');
  });

  it('encodes for the URL-safe alphabet Gmail wants', () => {
    expect(base64url(new TextEncoder().encode('~~~?'))).toBe('fn5-Pw');
    expect(base64url(new TextEncoder().encode(''))).toBe('');
  });

  it('sends nothing until every part of the account is set', () => {
    const full = { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GMAIL_SENDER: 'noreply@lahtiag.fi', GMAIL_REFRESH_TOKEN: 'c' };
    expect(mailConfigured(full)).toBe(true);
    expect(mailConfigured({ ...full, GMAIL_REFRESH_TOKEN: undefined })).toBe(false);
    expect(mailConfigured({ ...full, GMAIL_SENDER: '' })).toBe(false);
    expect(mailConfigured({})).toBe(false);
  });
});
