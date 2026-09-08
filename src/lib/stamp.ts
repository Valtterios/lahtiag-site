// The mark of the day: an icon derived from a secret and today's date in
// Helsinki. A buyer's live purchase page shows it next to items waiting
// to be collected, and the board's pages show the same one, so a
// screenshot from another day gives itself away.
//
// Which only works if two days rarely share a mark, and drawing one at
// random per day is not enough for that: independent draws from a list
// this size repeat somewhere inside a week more often than not, which
// reads as the mark being stuck and quietly lets a day-old screenshot
// through. So the marks are dealt instead. Each cycle of MARKS.length
// days is a shuffle of the whole list, seeded from the secret, and a day
// takes its place in that order: every mark falls exactly once per
// cycle. Where one cycle meets the next the deal could still repeat
// itself, so a new cycle's first week is dealt clear of the week that
// came before it. Two days in the same week therefore never share a
// mark, whatever falls between them.

const MARKS = [
  ['🦊', 'fox'],
  ['🐉', 'dragon'],
  ['🚀', 'rocket'],
  ['🎲', 'dice'],
  ['🏆', 'trophy'],
  ['🍕', 'pizza'],
  ['🐙', 'octopus'],
  ['⚡', 'bolt'],
  ['🍄', 'mushroom'],
  ['🦉', 'owl'],
  ['🎸', 'guitar'],
  ['🧊', 'ice cube'],
  ['🌶️', 'chili'],
  ['🐢', 'turtle'],
  ['🎈', 'balloon'],
  ['🔑', 'key'],
  ['🧲', 'magnet'],
  ['🐝', 'bee'],
  ['🌵', 'cactus'],
  ['🪐', 'planet'],
  ['🐧', 'penguin'],
  ['🍀', 'clover'],
  ['🎩', 'top hat'],
  ['🪁', 'kite'],
  ['🦖', 'dinosaur'],
  ['🍋', 'lemon'],
  ['🛸', 'saucer'],
  ['🧭', 'compass'],
  ['🐳', 'whale'],
  ['🎺', 'trumpet'],
] as const;

export function helsinkiDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSeconds * 1000));
}

// Days since 1970-01-01, counted off the Helsinki date string. Date.UTC
// on the parts, so the timezone is applied once and not again.
function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// One cycle's deal: a Fisher-Yates shuffle whose randomness is two HMACs
// of the cycle number, read two bytes at a time. The list is far smaller
// than the 65536 those two bytes span, so the modulo leans on no
// position enough to see.
async function deal(secret: string, cycle: number): Promise<number[]> {
  const [first, second] = await Promise.all([hmac(secret, `mark-cycle:${cycle}:0`), hmac(secret, `mark-cycle:${cycle}:1`)]);
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);
  const order = MARKS.map((_, i) => i);
  for (let i = order.length - 1, at = 0; i > 0; i--, at += 2) {
    const j = ((bytes[at] << 8) | bytes[at + 1]) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// How many days must never share a mark, however the cycles fall: a week,
// which is as old as a screenshot anyone would try is likely to be.
const NEAR = 7;

// Inside a cycle every mark differs already, so the seam is the only
// place a week could show the same mark twice: this cycle's first week
// is swapped clear of the last week of the one before. Partners come
// from the middle of the list only, never the last week of positions,
// which is what lets the cycle before be read undealt — the fix cannot
// have touched the part being read.
async function cycleOrder(secret: string, cycle: number): Promise<number[]> {
  const order = await deal(secret, cycle);
  const before = await deal(secret, cycle - 1);
  const recent = new Set(before.slice(before.length - NEAR));
  for (let p = 0; p < NEAR; p++) {
    if (!recent.has(order[p])) continue;
    for (let q = NEAR; q < order.length - NEAR; q++) {
      if (recent.has(order[q])) continue;
      [order[p], order[q]] = [order[q], order[p]];
      break;
    }
  }
  return order;
}

export async function dailyMark(secret: string, unixSeconds: number): Promise<{ icon: string; name: string }> {
  const day = dayNumber(helsinkiDate(unixSeconds));
  const cycle = Math.floor(day / MARKS.length);
  const order = await cycleOrder(secret, cycle);
  const [icon, name] = MARKS[order[day - cycle * MARKS.length]];
  return { icon, name };
}
