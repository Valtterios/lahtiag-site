// QR codes as inline SVG, for tickets. qrcode-generator is a small pure
// JavaScript encoder that runs fine in the Worker; the SVG needs no
// script and no external image, so the CSP stays as it is.

import qrcode from 'qrcode-generator';

// Error correction M: fine for a phone screen scanned at the door, and
// small enough to stay readable on a cheap print.
export function qrSvg(text: string, sizePx = 224): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  const cell = sizePx / total;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        const x = (c + quiet) * cell;
        const y = (r + quiet) * cell;
        path += `M${x} ${y}h${cell}v${cell}h-${cell}z`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sizePx} ${sizePx}" width="${sizePx}" height="${sizePx}" role="img" aria-label="Ticket QR code">` +
    `<rect width="${sizePx}" height="${sizePx}" fill="#fff"/><path d="${path}" fill="#1e1e1e"/></svg>`
  );
}

// Ticket codes: 10 characters from an alphabet without look-alikes, the
// last one a check character so a typo at the door is caught before the
// database is asked. 32^9 ≈ 3.5e13 possibilities; unguessable enough for
// a ticket that also needs to exist for a specific event.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newTicketCode(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let body = '';
  for (const b of bytes) body += ALPHABET[b % 32];
  return body + checkChar(body);
}

function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum * 7 + ALPHABET.indexOf(body[i])) % 32;
  return ALPHABET[sum];
}

// Normalises what a person typed or a scanner read; null when it cannot
// be a ticket code.
export function normalizeTicketCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
  // O and I are not in the alphabet; a scan of a real code never contains them.
  const code = s.replace(/O/g, '').replace(/I/g, '');
  if (code.length !== 10) return null;
  if (![...code].every((ch) => ALPHABET.includes(ch))) return null;
  return checkChar(code.slice(0, 9)) === code[9] ? code : null;
}

// What the QR carries: the ticket page's own URL, so any phone camera
// opens the ticket and the door page recognises the code at the end.
export function ticketUrl(origin: string, code: string): string {
  return `${origin}/tickets/${code}`;
}

export function codeFromScan(text: string): string | null {
  const tail = text.trim().split('/').pop() ?? '';
  return normalizeTicketCode(tail.split('?')[0]);
}
