// The membership application: the fixed choices the form offers and the
// validation both the public form and the board's edit form run. No SQL
// here — that lives in db.ts like everything else.

export const STUDENT_STATUSES = ['LUT', 'LAB', 'alumni', 'other'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];
export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  LUT: 'LUT University',
  LAB: 'LAB University of Applied Sciences',
  alumni: 'Alumni',
  other: 'Other',
};

export const UNIONS = ['LTKY', 'KOE', 'none'] as const;
export type Union = (typeof UNIONS)[number];
export const UNION_LABELS: Record<Union, string> = {
  LTKY: 'LTKY (LUT student union)',
  KOE: 'KOE (LAB student union)',
  none: 'Neither',
};

// The games list from the old Google Form, in its order. Adding one here
// is enough: the form, the validation and the register page all read this.
export const GAMES = [
  'Among Us',
  'Civilization 5/6',
  'Counter-Strike 2',
  'Deadlock',
  'Dota 2',
  'Fortnite',
  'Helldivers 2',
  'League of Legends',
  'Lethal Company',
  'Minecraft',
  'Osu',
  'Rainbow Six Siege',
  'Rocket League',
  'The Finals',
  'Valorant',
  'Sports',
  'Terraria',
] as const;

// The classes of membership in the association's rules (4 §): full
// (ordinary) members are current LUT/LAB students, external members are
// everyone else who applies, supporting members back the association
// without taking part, honorary members are invited by the general
// meeting. An application yields full or external from the student
// status; the other two are set by the board on the entry page.
export const MEMBER_TYPES = ['full', 'external', 'supporting', 'honorary'] as const;
export type MemberType = (typeof MEMBER_TYPES)[number];
export const MEMBER_TYPE_LABELS: Record<MemberType, string> = {
  full: 'Full member',
  external: 'External member',
  supporting: 'Supporting member',
  honorary: 'Honorary member',
};

export function deriveMemberType(studentStatus: StudentStatus): MemberType {
  return studentStatus === 'LUT' || studentStatus === 'LAB' ? 'full' : 'external';
}

export const REGISTER_STATUSES = ['pending', 'member', 'former'] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];

export const LIMITS = {
  full_name: 100,
  domicile: 60,
  email: 254,
  telegram: 40,
  discord_name: 40,
  games_other: 80,
  message: 500,
  board_note: 500,
} as const;

export interface ApplicationInput {
  full_name: string;
  domicile: string;
  email: string;
  student_status: StudentStatus;
  union_member: Union;
  telegram: string | null;
  discord_name: string | null;
  games: string | null;
  wants_active: boolean;
  message: string | null;
}

export type FieldError =
  | 'full_name'
  | 'domicile'
  | 'email'
  | 'student_status'
  | 'union_member'
  | 'telegram'
  | 'discord_name'
  | 'games'
  | 'message'
  | 'consent';

// Deliberately loose: one @, something on both sides, no whitespace. The
// board reads these addresses; nothing here sends mail to them.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(form: FormData, name: string, max: number): string {
  return String(form.get(name) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
}

function optional(form: FormData, name: string, max: number): string | null {
  const value = text(form, name, max);
  return value === '' ? null : value;
}

// Telegram and Discord handles: people paste "@name", "name", or a full
// t.me link. Keep what they typed minus a leading @ and surrounding noise.
export function normalizeHandle(raw: string): string | null {
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value === '') return null;
  return value.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '');
}

function handle(form: FormData, name: string, max: number): string | null {
  const value = optional(form, name, max);
  if (value === null) return null;
  return normalizeHandle(value);
}

// Parse and validate the form. `requireConsent` is true for the public
// application (the checkbox is what makes storing the data lawful) and
// false for the board's edit form, which changes an existing consented row.
export function parseApplication(
  form: FormData,
  requireConsent: boolean,
): { ok: true; value: ApplicationInput } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];

  const full_name = text(form, 'full_name', LIMITS.full_name);
  if (full_name.length < 2 || full_name.length > LIMITS.full_name) errors.push('full_name');

  const domicile = text(form, 'domicile', LIMITS.domicile);
  if (domicile.length < 2 || domicile.length > LIMITS.domicile) errors.push('domicile');

  const email = text(form, 'email', LIMITS.email).toLowerCase();
  if (!EMAIL.test(email) || email.length > LIMITS.email) errors.push('email');

  const studentRaw = String(form.get('student_status') ?? '');
  const student_status = STUDENT_STATUSES.find((s) => s === studentRaw);
  if (!student_status) errors.push('student_status');

  const unionRaw = String(form.get('union_member') ?? '');
  const union_member = UNIONS.find((u) => u === unionRaw);
  if (!union_member) errors.push('union_member');

  const telegram = handle(form, 'telegram', LIMITS.telegram);
  if (telegram !== null && telegram.length > LIMITS.telegram) errors.push('telegram');

  const discord_name = handle(form, 'discord_name', LIMITS.discord_name);
  if (discord_name !== null && discord_name.length > LIMITS.discord_name) errors.push('discord_name');

  // Checkboxes arrive as repeated `games` fields; anything not on the list
  // is dropped silently rather than failing the whole form. The "other"
  // text is appended as its own entry.
  const picked = form
    .getAll('games')
    .map((g) => String(g))
    .filter((g): g is (typeof GAMES)[number] => (GAMES as readonly string[]).includes(g));
  const other = optional(form, 'games_other', LIMITS.games_other);
  if (other !== null && other.length > LIMITS.games_other) errors.push('games');
  const gamesList: string[] = [...new Set(picked)];
  if (other !== null) gamesList.push(other.replace(/,/g, ' '));
  const games = gamesList.length > 0 ? gamesList.join(', ') : null;

  const wants_active = form.get('wants_active') === 'on';

  const message = optional(form, 'message', LIMITS.message);
  if (message !== null && message.length > LIMITS.message) errors.push('message');

  if (requireConsent && form.get('consent') !== 'on') errors.push('consent');

  if (errors.length > 0 || !student_status || !union_member) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      full_name,
      domicile,
      email,
      student_status,
      union_member,
      telegram,
      discord_name,
      games,
      wants_active,
      message,
    },
  };
}

// Spreadsheet formula injection: a cell beginning with = + - @ (or a tab or
// carriage return) is executed by Excel and LibreOffice when the CSV is
// opened. A leading apostrophe makes it text again; the value itself is
// what the person typed, so this is the one place it is escaped.
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
