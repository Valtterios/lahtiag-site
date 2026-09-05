import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { requireBoard } from '../../lib/board';
import { listRegister } from '../../lib/db';
import { csvCell, REGISTER_STATUSES, type RegisterStatus } from '../../lib/register';
import { formatHelsinkiDate } from '../../lib/time';

// The register as a spreadsheet, for the annual report or a backup. A
// read, so no CSRF; the Google step-up is checked like on the pages.
// Cells are escaped against formula injection (register.ts, csvCell).

const COLUMNS = [
  'id',
  'status',
  'member_type',
  'full_name',
  'domicile',
  'email',
  'student_status',
  'union_member',
  'discord_name',
  'discord_id',
  'telegram',
  'games',
  'wants_active',
  'applied',
  'decided',
  'source',
  'message',
  'board_note',
];

export const GET: APIRoute = async ({ request, redirect, url }) => {
  const board = await requireBoard(request, env);
  if (!board.ok) return redirect(`/register?err=${board.reason}`, 303);

  const statusParam = url.searchParams.get('status') ?? 'all';
  const status: RegisterStatus | 'all' = (REGISTER_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as RegisterStatus)
    : 'all';
  const rows = await listRegister(env.DB, { status, limit: 10000 });

  const lines = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.status,
        r.member_type,
        r.full_name,
        r.domicile,
        r.email,
        r.student_status,
        r.union_member,
        r.discord_name,
        r.discord_id,
        r.telegram,
        r.games,
        r.wants_active ? 'yes' : 'no',
        formatHelsinkiDate(r.applied_at),
        r.decided_at === null ? null : formatHelsinkiDate(r.decided_at),
        r.source,
        r.message,
        r.board_note,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const suffix = status === 'all' ? '' : `-${status}`;
  // BOM so Excel opens ä/ö correctly without an import wizard.
  return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="lahtiag-register-${today}${suffix}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
