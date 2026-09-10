// Pictures that fold up: a /pass or /profile card is posted for everyone
// to see, and a minute later the cron turns the message into one line
// saying whose it was, picture and buttons gone, so the channel keeps a
// footprint rather than a wall of cards. A Worker cannot wait a minute
// itself, so the message is noted here and the next cron run (every
// five minutes) does the fold; "a minute" is one to six in practice.
import type { D1Database } from '@cloudflare/workers-types';
import { collapseChannelMessage } from './discord';

export const COLLAPSE_AFTER = 60; // seconds a picture stays whole
const GIVE_UP_AFTER = 24 * 3600; // a fold that keeps failing is dropped

export async function scheduleCollapse(db: D1Database, message: { id: string; channel_id: string }, text: string, now: number): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO collapsing_messages (channel_id, message_id, text, collapse_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(message.channel_id, message.id, text, now + COLLAPSE_AFTER)
    .run();
}

export async function listDueCollapses(db: D1Database, now: number): Promise<{ channel_id: string; message_id: string; text: string; collapse_at: number }[]> {
  const { results } = await db
    .prepare('SELECT channel_id, message_id, text, collapse_at FROM collapsing_messages WHERE collapse_at <= ?1 ORDER BY collapse_at')
    .bind(now)
    .all<{ channel_id: string; message_id: string; text: string; collapse_at: number }>();
  return results;
}

// The cron step: fold what is due. A message Discord no longer has (someone
// deleted it) is simply forgotten; a fold that fails for another reason
// is tried again next run, for a day.
export async function collapseDue(db: D1Database, env: { DISCORD_BOT_TOKEN?: string }, now: number): Promise<number> {
  if (!env.DISCORD_BOT_TOKEN) return 0;
  let folded = 0;
  for (const m of await listDueCollapses(db, now)) {
    const result = await collapseChannelMessage(env.DISCORD_BOT_TOKEN, m.channel_id, m.message_id, m.text);
    const done = result.ok || result.status === 404 || now - m.collapse_at > GIVE_UP_AFTER;
    if (done) await db.prepare('DELETE FROM collapsing_messages WHERE channel_id = ?1 AND message_id = ?2').bind(m.channel_id, m.message_id).run();
    if (result.ok) folded++;
  }
  return folded;
}
