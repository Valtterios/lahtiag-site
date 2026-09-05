// The basket: what a visitor means to buy, kept in a cookie until checkout.
// Ticket types and shop products, each with a count. Nothing is held or
// priced here; the checkout page prices every line afresh and drops what
// is no longer on sale.

export const BASKET_COOKIE = '__Host-basket';
export const BASKET_MAX_LINES = 12;

export interface BasketLine {
  kind: 'ticket' | 'item';
  id: number;
  count: number;
}

interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: Record<string, unknown>): void;
  delete(name: string, options: Record<string, unknown>): void;
}

export function parseBasket(raw: string | undefined): BasketLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const lines: BasketLine[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const { k, i, n } = entry as { k?: unknown; i?: unknown; n?: unknown };
      const kind = k === 't' ? 'ticket' : k === 'p' ? 'item' : null;
      if (!kind || !Number.isInteger(i) || !Number.isInteger(n)) continue;
      if ((i as number) <= 0 || (n as number) <= 0) continue;
      if (lines.some((l) => l.kind === kind && l.id === i)) continue;
      lines.push({ kind, id: i as number, count: Math.min(n as number, 99) });
      if (lines.length >= BASKET_MAX_LINES) break;
    }
    return lines;
  } catch {
    return [];
  }
}

export function serializeBasket(lines: BasketLine[]): string {
  return JSON.stringify(lines.map((l) => ({ k: l.kind === 'ticket' ? 't' : 'p', i: l.id, n: l.count })));
}

export function readBasket(cookies: CookieJar): BasketLine[] {
  return parseBasket(cookies.get(BASKET_COOKIE)?.value);
}

// A __Host- cookie is only accepted (and only deleted) with Secure and
// Path=/; a deletion without them is silently ignored by the browser.
export function writeBasket(cookies: CookieJar, lines: BasketLine[]): void {
  if (lines.length === 0) {
    cookies.delete(BASKET_COOKIE, { path: '/', secure: true });
    return;
  }
  cookies.set(BASKET_COOKIE, serializeBasket(lines), {
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
}

// Add `count` of a line (or set it, with `set`); a count of zero removes it.
export function withLine(lines: BasketLine[], line: BasketLine, set = false): BasketLine[] {
  const rest = lines.filter((l) => !(l.kind === line.kind && l.id === line.id));
  const existing = lines.find((l) => l.kind === line.kind && l.id === line.id);
  const count = set ? line.count : (existing?.count ?? 0) + line.count;
  if (count <= 0) return rest;
  const updated = { kind: line.kind, id: line.id, count: Math.min(count, 99) };
  return existing ? lines.map((l) => (l.kind === line.kind && l.id === line.id ? updated : l)) : [...rest, updated].slice(0, BASKET_MAX_LINES);
}

export function basketCount(lines: BasketLine[]): number {
  return lines.reduce((sum, l) => sum + l.count, 0);
}
