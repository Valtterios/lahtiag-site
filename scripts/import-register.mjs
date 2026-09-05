// One-time import of the old Google Form responses into the member
// register. Runs locally, never in the Worker: the sheet export and the
// generated SQL both hold personal data and are gitignored (*.csv,
// *.import.sql).
//
//   1. In the nonprofit's Google Drive open the responses sheet →
//      File → Download → Comma-separated values (.csv).
//   2. node scripts/import-register.mjs responses.csv --dry-run
//      (shows how the columns were matched and how many rows would load)
//   3. node scripts/import-register.mjs responses.csv > register.import.sql
//   4. npx wrangler d1 execute lahtiag --remote --file=register.import.sql
//   5. shred -u responses.csv register.import.sql
//
// Rows are matched by the Google Form's question titles, so the sheet's
// column order does not matter. Duplicate emails keep the LATEST response.
// Every imported row is an approved member (they were on the register).

import { readFileSync } from 'node:fs';

const [, , file, ...flags] = process.argv;
const dryRun = flags.includes('--dry-run');
if (!file) {
  console.error('Usage: node scripts/import-register.mjs responses.csv [--dry-run] > register.import.sql');
  process.exit(1);
}

// --- CSV --------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

// --- column matching --------------------------------------------------------

// Each register field lists the header fragments (lower-cased) that identify
// its column in the export. The first header containing a fragment wins.
const COLUMNS = {
  timestamp: ['timestamp', 'aikaleima'],
  email: ['sähköposti', 'email', 'e-mail'],
  full_name: ['full name', 'name', 'nimi'],
  domicile: ['domicile', 'kotikunta', 'municipality'],
  telegram: ['telegram'],
  discord_name: ['discord'],
  games: ['interested in the following games', 'games'],
  union_member: ['ltky', 'koe'],
  student_status: ['student status', 'study'],
  member_type: ['membership type', 'member type'],
  message: ['questions'],
};

function matchColumns(headers) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const found = {};
  const taken = new Set();
  for (const [field, fragments] of Object.entries(COLUMNS)) {
    for (const fragment of fragments) {
      const idx = lower.findIndex((h, i) => !taken.has(i) && h.includes(fragment));
      if (idx >= 0) {
        found[field] = idx;
        taken.add(idx);
        break;
      }
    }
  }
  return found;
}

// --- value mapping ----------------------------------------------------------

// Helsinki wall-clock -> unix seconds, DST-aware: take the wall-clock as if
// it were UTC, ask Intl what Helsinki shows at that instant, and shift by
// the difference (one refinement pass covers the transition hours).
const HELSINKI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});
function helsinkiToUnix(y, mo, d, h, mi, se) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(HELSINKI.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    guess -= shown - wall;
  }
  return Math.floor(guess / 1000);
}

// Google exports timestamps in the sheet's locale: "2024/09/12 3:45:12 PM
// EEST" (English) or "12.9.2024 klo 15.45.12" (Finnish). Unknown formats
// fall back to now, flagged on stderr.
function parseTimestamp(raw) {
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\D+(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, h = '12', mi = '0', se = '0'] = m;
    return helsinkiToUnix(+y, +mo, +d, +h, +mi, +se);
  }
  m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (m) {
    const [, y, mo, d, hRaw = '12', mi = '0', se = '0', ampm] = m;
    let h = +hRaw;
    if (ampm && ampm.toUpperCase() === 'PM' && h < 12) h += 12;
    if (ampm && ampm.toUpperCase() === 'AM' && h === 12) h = 0;
    return helsinkiToUnix(+y, +mo, +d, h, +mi, +se);
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  return null;
}

function studentStatus(raw) {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('lut')) return 'LUT';
  if (s.startsWith('lab')) return 'LAB';
  if (s.startsWith('alumn')) return 'alumni';
  return 'other';
}

// The board's own classification column, when the sheet has one ("Full
// member" / "Outside member"; the rules call the latter external); else
// derived the same way the site does (LUT/LAB students are full members).
function memberType(raw, student) {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('full') || s.startsWith('ordinary')) return 'full';
  if (s.startsWith('outside') || s.startsWith('external')) return 'external';
  if (s.startsWith('support')) return 'supporting';
  if (s.startsWith('honor')) return 'honorary';
  return student === 'LUT' || student === 'LAB' ? 'full' : 'external';
}

function union(raw) {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('ltky')) return 'LTKY';
  if (s.startsWith('koe')) return 'KOE';
  return 'none';
}

function handle(raw) {
  const s = raw
    .trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '');
  return s === '' ? null : s.slice(0, 40);
}

function games(raw) {
  const items = raw
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g !== '');
  return items.length === 0 ? null : items.join(', ');
}

// Mirrors searchKey() in src/lib/register.ts.
function searchKey(parts) {
  return parts
    .filter((p) => typeof p === 'string' && p !== '')
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

// --- main -------------------------------------------------------------------

const rows = parseCsv(readFileSync(file, 'utf8').replace(/^﻿/, ''));
if (rows.length < 2) {
  console.error('The file has no data rows.');
  process.exit(1);
}
const [headers, ...data] = rows;
const col = matchColumns(headers);
for (const required of ['email', 'full_name', 'domicile']) {
  if (col[required] === undefined) {
    console.error(`Could not find a column for "${required}". Headers were:\n  ${headers.join('\n  ')}`);
    process.exit(1);
  }
}
console.error('Column mapping:');
for (const [field, idx] of Object.entries(col)) console.error(`  ${field.padEnd(15)} ← "${headers[idx]}"`);
const unmatched = headers.filter((_, i) => !Object.values(col).includes(i));
if (unmatched.length) console.error(`Ignored columns: ${unmatched.map((h) => `"${h}"`).join(', ')}`);

const get = (row, field) => (col[field] === undefined ? '' : (row[col[field]] ?? ''));
const now = Math.floor(Date.now() / 1000);
const byEmail = new Map();
let skipped = 0;
let badTimestamps = 0;
for (const row of data) {
  const email = get(row, 'email').trim().toLowerCase();
  const full_name = get(row, 'full_name').replace(/\s+/g, ' ').trim().slice(0, 100);
  const domicile = get(row, 'domicile').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!email.includes('@') || full_name.length < 2 || domicile.length < 2) {
    skipped++;
    continue;
  }
  let applied_at = col.timestamp === undefined ? now : parseTimestamp(get(row, 'timestamp'));
  if (applied_at === null) {
    badTimestamps++;
    applied_at = now;
  }
  const student_status = studentStatus(get(row, 'student_status'));
  const entry = {
    full_name,
    domicile,
    email,
    student_status,
    member_type: memberType(get(row, 'member_type'), student_status),
    union_member: union(get(row, 'union_member')),
    telegram: handle(get(row, 'telegram')),
    discord_name: handle(get(row, 'discord_name')),
    games: games(get(row, 'games')),
    message: get(row, 'message').trim().slice(0, 500) || null,
    applied_at,
  };
  const prior = byEmail.get(email);
  if (!prior || prior.applied_at <= applied_at) byEmail.set(email, entry);
}

console.error(
  `${data.length} rows read, ${skipped} skipped (missing email/name/domicile), ` +
    `${data.length - skipped - byEmail.size} older duplicates dropped, ${byEmail.size} to import` +
    (badTimestamps ? `, ${badTimestamps} unparseable timestamps set to now` : ''),
);
if (dryRun) process.exit(0);

const lines = [
  '-- Generated by scripts/import-register.mjs. Contains personal data: do not commit.',
  '-- Rows whose email already exists in the register are skipped (INSERT OR IGNORE).',
];
for (const e of byEmail.values()) {
  lines.push(
    `INSERT OR IGNORE INTO register (full_name, domicile, email, student_status, union_member, member_type, telegram, discord_name, games, wants_active, message, status, source, applied_at, consented_at, decided_at, updated_at, search_key) VALUES (` +
      [
        e.full_name,
        e.domicile,
        e.email,
        e.student_status,
        e.union_member,
        e.member_type,
        e.telegram,
        e.discord_name,
        e.games,
        0,
        e.message,
        'member',
        'import',
        e.applied_at,
        e.applied_at,
        e.applied_at,
        now,
        searchKey([e.full_name, e.email, e.discord_name, e.telegram]),
      ]
        .map(sql)
        .join(', ') +
      ');',
  );
}
process.stdout.write(lines.join('\n') + '\n');
