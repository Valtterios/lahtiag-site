// Times are stored as UTC unix seconds and rendered in Europe/Helsinki
// (spec, Data model). Storing wall-clock time would silently shift events
// across the two annual DST transitions, so conversion happens here, in
// both directions, and nowhere else.

const TZ = 'Europe/Helsinki';

// Helsinki's UTC offset in seconds at a given instant, via Intl rather than
// a bundled timezone table: workerd ships full ICU.
function offsetSeconds(utcMs: number): number {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((wallAsUtc - utcMs) / 1000);
}

// "2026-09-12" + "18:00" as Helsinki wall-clock -> unix seconds. Two-pass:
// the first guess assumes the offset at the naive instant, the second
// re-reads the offset at the guessed instant, which settles the two nights
// a year where they differ.
export function helsinkiToUnix(date: string, time: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{1,2})[:.](\d{2})$/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;
  const [, y, mo, d] = dateMatch.map(Number);
  const [, h, mi] = timeMatch.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const naiveMs = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(naiveMs)) return null;
  let ts = naiveMs / 1000 - offsetSeconds(naiveMs);
  ts = naiveMs / 1000 - offsetSeconds(ts * 1000);
  return ts;
}

// unix seconds -> "Sat 12 Sep 2026, 18:00" in Helsinki time.
export function formatHelsinki(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSeconds * 1000));
}
