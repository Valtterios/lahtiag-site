import type { D1Database } from '@cloudflare/workers-types';
import { getAnnouncementCover, RuleError, type AnnouncementRow } from './db';
import { postWebhook, postWebhookWithFile, NO_MENTIONS, SUPPRESS_EMBEDS, type MessageFile } from './discord';
import { SITE_ORIGIN } from './config';

// A news post on Discord: the title, the Markdown body, and the cover
// attached when the post has one (then link previews stay off, the
// picture is the visual). A post can ping @everyone or one role.

// Discord takes 2000 characters in a message. A longer post is cut at a
// paragraph and ends with a link to the whole of it on the site.
export const DISCORD_MESSAGE_MAX = 2000;

export function newsText(post: Pick<AnnouncementRow, 'title' | 'body_md'> & { id?: number }, room = DISCORD_MESSAGE_MAX): string {
  const head = `📣 **${post.title}**\n`;
  const full = head + post.body_md;
  if (full.length <= room) return full;
  const tail = `\n…\nThe whole post: ${SITE_ORIGIN}/announcements${post.id ? `#post-${post.id}` : ''}`;
  const budget = Math.max(0, room - head.length - tail.length);
  let cut = post.body_md.lastIndexOf('\n\n', budget);
  if (cut < budget / 2) cut = post.body_md.lastIndexOf(' ', budget);
  if (cut <= 0) cut = budget;
  return head + post.body_md.slice(0, cut).trimEnd() + tail;
}

// The form's ping choice: nobody, everyone, or a role id.
export function parsePing(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (text === '' || text === 'none') return null;
  if (text === 'everyone') return 'everyone';
  if (/^\d{17,20}$/.test(text)) return text;
  throw new RuleError('bad_input', 'Unknown ping choice.');
}

export function newsPayload(post: Pick<AnnouncementRow, 'title' | 'body_md' | 'ping'> & { id?: number }): { content: string; mentions: { parse: string[]; roles?: string[] } } {
  const prefix = post.ping === 'everyone' ? '@everyone ' : post.ping ? `<@&${post.ping}> ` : '';
  const content = prefix + newsText(post, DISCORD_MESSAGE_MAX - prefix.length);
  if (post.ping === 'everyone') return { content, mentions: { parse: ['everyone'] } };
  if (post.ping) return { content, mentions: { parse: [], roles: [post.ping] } };
  return { content, mentions: NO_MENTIONS };
}

export function pingLabel(ping: string | null, roleNames: Map<string, string>): string | null {
  if (!ping) return null;
  if (ping === 'everyone') return '@everyone';
  return `@${roleNames.get(ping) ?? 'a role'}`;
}

export async function newsCoverFile(db: D1Database, id: number): Promise<MessageFile | null> {
  const cover = await getAnnouncementCover(db, id);
  if (!cover || cover.bytes.byteLength === 0) return null;
  const ext = cover.content_type === 'image/png' ? 'png' : cover.content_type === 'image/webp' ? 'webp' : 'jpg';
  return { name: `news-${id}.${ext}`, bytes: new Uint8Array(cover.bytes), type: cover.content_type };
}

export async function postNews(db: D1Database, webhookUrl: string, post: Pick<AnnouncementRow, 'id' | 'title' | 'body_md' | 'ping'>): Promise<string | null> {
  const file = await newsCoverFile(db, post.id);
  const { content, mentions } = newsPayload(post);
  return file ? postWebhookWithFile(webhookUrl, content, file, mentions, SUPPRESS_EMBEDS) : postWebhook(webhookUrl, content, mentions);
}
