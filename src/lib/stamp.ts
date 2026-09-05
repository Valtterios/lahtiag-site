// The mark of the day: an icon derived from a secret and today's date in
// Helsinki. A buyer's live purchase page shows it next to items waiting
// to be collected, and the board's pages show the same one, so a
// screenshot from another day gives itself away.

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
] as const;

export function helsinkiDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSeconds * 1000));
}

export async function dailyMark(secret: string, unixSeconds: number): Promise<{ icon: string; name: string }> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`mark:${helsinkiDate(unixSeconds)}`)));
  const [icon, name] = MARKS[((digest[0] << 8) | digest[1]) % MARKS.length];
  return { icon, name };
}
