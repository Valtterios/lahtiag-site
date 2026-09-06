import type { D1Database } from '@cloudflare/workers-types';
import { getAnnouncementCover, type AnnouncementRow } from './db';
import { postWebhook, postWebhookWithFile, NO_MENTIONS, SUPPRESS_EMBEDS, type MessageFile } from './discord';

// A news post on Discord: the title, the Markdown body, and the cover
// attached when the post has one (then link previews stay off, the
// picture is the visual).

export function newsText(post: Pick<AnnouncementRow, 'title' | 'body_md'>): string {
  return `📣 **${post.title}**\n${post.body_md}`;
}

export async function newsCoverFile(db: D1Database, id: number): Promise<MessageFile | null> {
  const cover = await getAnnouncementCover(db, id);
  if (!cover || cover.bytes.byteLength === 0) return null;
  const ext = cover.content_type === 'image/png' ? 'png' : cover.content_type === 'image/webp' ? 'webp' : 'jpg';
  return { name: `news-${id}.${ext}`, bytes: new Uint8Array(cover.bytes), type: cover.content_type };
}

export async function postNews(db: D1Database, webhookUrl: string, post: Pick<AnnouncementRow, 'id' | 'title' | 'body_md'>): Promise<string | null> {
  const file = await newsCoverFile(db, post.id);
  return file ? postWebhookWithFile(webhookUrl, newsText(post), file, NO_MENTIONS, SUPPRESS_EMBEDS) : postWebhook(webhookUrl, newsText(post));
}
