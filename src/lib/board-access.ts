// The gate on the board's own pages (the hub at /board, the season page):
// open to the Discord Board role and to the register accounts alike, since
// nothing on them is the register's personal data. `who` is the name a
// change made there is recorded under: the Discord username, or the
// Google address for the register accounts.
import type { D1Database } from '@cloudflare/workers-types';
import type { Session } from './auth';
import { currentSession, requireAdmin } from './guard';
import { requireBoard } from './board';

export type BoardAccess =
  | { ok: true; who: string; full: boolean; session: Session | null }
  | { ok: false; status: number; reason: 'unauthenticated' | 'forbidden' | 'discord_down' };

export async function requireAnyBoard(
  request: Request,
  env: { SESSION_SECRET?: string; GOOGLE_CLIENT_ID?: string; REGISTER_ADMINS?: string; DB?: D1Database; ADMIN_ROLE_ID: string },
): Promise<BoardAccess> {
  const board = await requireBoard(request, env);
  if (board.ok) return { ok: true, who: board.email, full: true, session: await currentSession(request, env) };
  const admin = await requireAdmin(request, env);
  if (admin.ok) return { ok: true, who: admin.session.username, full: false, session: admin.session };
  const status = admin.reason === 'unauthenticated' ? 401 : admin.reason === 'discord_down' ? 503 : 403;
  return { ok: false, status, reason: admin.reason };
}
