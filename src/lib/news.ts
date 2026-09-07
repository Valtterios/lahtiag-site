import type { D1Database } from '@cloudflare/workers-types';
import { getAnnouncementCover, RuleError, type AnnouncementRow } from './db';
import {
  postWebhook,
  postWebhookWithFile,
  editWebhookMessage,
  editWebhookMessageFile,
  deleteWebhookMessage,
  NO_MENTIONS,
  SUPPRESS_EMBEDS,
  type MessageFile,
} from './discord';

// A news post on Discord: the cover as its own message first, when the
// post has one, then the text in as many messages as it takes, the first
// carrying the ping and the title. Discord holds 2000 characters per
// message, so a long post is split at paragraphs (a paragraph longer
// than a message at a space). Every message id is kept, so an edit
// rewrites every part and a delete takes all of them.

export const DISCORD_MESSAGE_MAX = 2000;

export interface NewsMessages {
  image: string | null; // the message with the cover, if any
  parts: string[]; // the text, in order
}

export function newsText(post: Pick<AnnouncementRow, 'title' | 'body_md'>): string {
  return `📣 **${post.title}**\n${post.body_md}`;
}

// The form's ping choice: nobody, everyone, or a role id.
// The first line or two of a post, without its Markdown, for a card that
// only teases it (the front page).
export function newsExcerpt(post: Pick<AnnouncementRow, 'body_md'>, max = 160): string {
  const plain = post.body_md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max - 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function parsePing(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (text === '' || text === 'none') return null;
  if (text === 'everyone') return 'everyone';
  if (/^\d{17,20}$/.test(text)) return text;
  throw new RuleError('bad_input', 'Unknown ping choice.');
}

function pingPrefix(ping: string | null): string {
  return ping === 'everyone' ? '@everyone ' : ping ? `<@&${ping}> ` : '';
}

export function pingMentions(ping: string | null): { parse: string[]; roles?: string[] } {
  if (ping === 'everyone') return { parse: ['everyone'] };
  if (ping) return { parse: [], roles: [ping] };
  return NO_MENTIONS;
}

// Paragraphs packed into messages: as many whole paragraphs per message
// as fit, the first message with less room for the ping and the title.
// A paragraph longer than the room left is cut at spaces.
function packParagraphs(body: string, firstRoom: number, room: number): string[] {
  const parts: string[] = [];
  let current = '';
  let limit = firstRoom;
  const flush = () => {
    parts.push(current);
    current = '';
    limit = room;
  };
  for (const paragraph of body.split(/\n{2,}/)) {
    const joined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (joined.length <= limit) {
      current = joined;
      continue;
    }
    if (current) flush();
    let rest = paragraph;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(' ', limit);
      if (cut < limit / 2) cut = limit;
      current = rest.slice(0, cut).trimEnd();
      flush();
      rest = rest.slice(cut).trimStart();
    }
    current = rest;
  }
  if (current || parts.length === 0) parts.push(current);
  return parts;
}

// The text messages for a post, ping and title on the first.
export function newsParts(post: Pick<AnnouncementRow, 'title' | 'body_md' | 'ping'>, max = DISCORD_MESSAGE_MAX): string[] {
  const head = `${pingPrefix(post.ping)}📣 **${post.title}**\n`;
  const chunks = packParagraphs(post.body_md.trim(), Math.max(1, max - head.length), max);
  return chunks.map((chunk, i) => (i === 0 ? head + chunk : chunk));
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

// The messages a post has on Discord. Posts from before the split kept
// one id, with the cover attached to that same message.
export function newsMessages(post: Pick<AnnouncementRow, 'discord_message_id' | 'discord_messages'>): (NewsMessages & { legacy: boolean }) | null {
  if (post.discord_messages) {
    try {
      const parsed = JSON.parse(post.discord_messages) as NewsMessages;
      if (Array.isArray(parsed.parts)) return { image: parsed.image ?? null, parts: parsed.parts, legacy: false };
    } catch {
      // fall through to the single id
    }
  }
  if (post.discord_message_id) return { image: null, parts: [post.discord_message_id], legacy: true };
  return null;
}

// Post it: the cover first, then the parts. Nothing to show for it if the
// first part fails; a cover that fails to post is simply left out.
export async function postNews(db: D1Database, webhookUrl: string, post: Pick<AnnouncementRow, 'id' | 'title' | 'body_md' | 'ping'>): Promise<NewsMessages | null> {
  const file = await newsCoverFile(db, post.id);
  const image = file ? await postWebhookWithFile(webhookUrl, '', file, NO_MENTIONS, SUPPRESS_EMBEDS) : null;
  const parts: string[] = [];
  for (const [i, text] of newsParts(post).entries()) {
    const id = await postWebhook(webhookUrl, text, i === 0 ? pingMentions(post.ping) : NO_MENTIONS, SUPPRESS_EMBEDS);
    if (!id) {
      if (i === 0) {
        if (image) await deleteWebhookMessage(webhookUrl, image);
        return null;
      }
      break;
    }
    parts.push(id);
  }
  return { image, parts };
}

// An edited post: each part rewritten in place, new parts added at the
// end, parts no longer needed deleted.
export async function syncNewsMessages(
  webhookUrl: string,
  post: Pick<AnnouncementRow, 'title' | 'body_md' | 'ping'>,
  existing: NewsMessages,
): Promise<NewsMessages> {
  const texts = newsParts(post);
  const parts: string[] = [];
  for (const [i, text] of texts.entries()) {
    const current = existing.parts[i];
    if (current) {
      await editWebhookMessage(webhookUrl, current, text);
      parts.push(current);
    } else {
      const id = await postWebhook(webhookUrl, text, NO_MENTIONS, SUPPRESS_EMBEDS);
      if (!id) break;
      parts.push(id);
    }
  }
  for (const stale of existing.parts.slice(texts.length)) await deleteWebhookMessage(webhookUrl, stale);
  return { image: existing.image, parts };
}

// A new cover on a published post: the cover message gets the picture;
// a post from before the split carries it on its one message; a post
// that had none gets a cover message after its text.
export async function replaceNewsCover(webhookUrl: string, existing: NewsMessages & { legacy: boolean }, file: MessageFile): Promise<NewsMessages> {
  if (existing.image) {
    await editWebhookMessageFile(webhookUrl, existing.image, file);
    return existing;
  }
  if (existing.legacy && existing.parts[0]) {
    await editWebhookMessageFile(webhookUrl, existing.parts[0], file);
    return existing;
  }
  const image = await postWebhookWithFile(webhookUrl, '', file, NO_MENTIONS, SUPPRESS_EMBEDS);
  return { image, parts: existing.parts };
}

export async function removeNewsCover(webhookUrl: string, existing: NewsMessages): Promise<NewsMessages> {
  if (existing.image) await deleteWebhookMessage(webhookUrl, existing.image);
  return { image: null, parts: existing.parts };
}

export async function deleteNewsMessages(webhookUrl: string, existing: NewsMessages): Promise<void> {
  for (const id of [existing.image, ...existing.parts]) if (id) await deleteWebhookMessage(webhookUrl, id);
}
