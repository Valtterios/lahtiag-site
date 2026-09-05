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

// unix seconds -> the {date, time} strings the event forms use, in
// Helsinki time — for prefilled edit forms.
export function unixToHelsinkiInputs(unixSeconds: number): { date: string; time: string } {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(unixSeconds * 1000))) {
    parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`,
  };
}

// "Sat 12 Sep 2026, 18:00 to 22:00" (same day) or both full timestamps
// when the event runs past midnight. No end time: just the start.
export function formatHelsinkiRange(start: number, end: number | null): string {
  const startText = formatHelsinki(start);
  if (end === null) return startText;
  const sameDay = unixToHelsinkiInputs(start).date === unixToHelsinkiInputs(end).date;
  const endText = sameDay
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(end * 1000))
    : formatHelsinki(end);
  return `${startText} to ${endText}`;
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

// unix seconds -> "12 Sep 2026" in Helsinki time, for the register where
// the day matters and the hour never does.
export function formatHelsinkiDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(unixSeconds * 1000));
}
