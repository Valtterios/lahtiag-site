import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createAnnouncement, listAnnouncements, deleteAnnouncement, getAnnouncement, updateAnnouncement, getAnnouncementCover, setAnnouncementCover, deleteAnnouncementCover, COVER_MAX_BYTES } from '../src/lib/db';
import { newsCoverFile, newsText, newsParts, newsMessages, pingMentions, parsePing, pingLabel } from '../src/lib/news';
import { publishAnnouncement, unpublishAnnouncement, setAnnouncementMessages } from '../src/lib/db';

// A news post's cover: saved, listed as a version, attached for Discord,
// gone with the post.

const NOW = 1_760_000_000;
const db = () => env.DB;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

describe('news covers', () => {
  beforeEach(async () => {
    for (const table of ['announcement_covers', 'announcements', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
    await upsertMember(db(), { discord_id: 'board', username: 'Board', avatar_hash: null }, NOW);
  });

  it('pings nobody, everyone, or one role', async () => {
    expect(parsePing('')).toBeNull();
    expect(parsePing('none')).toBeNull();
    expect(parsePing('everyone')).toBe('everyone');
    expect(parsePing('123456789012345678')).toBe('123456789012345678');
    expect(() => parsePing('@here')).toThrow();
    expect(newsParts({ title: 'T', body_md: 'B', ping: null })).toEqual(['📣 **T**\nB']);
    expect(newsParts({ title: 'T', body_md: 'B', ping: 'everyone' })).toEqual(['@everyone 📣 **T**\nB']);
    expect(newsParts({ title: 'T', body_md: 'B', ping: '42' })).toEqual(['<@&42> 📣 **T**\nB']);
    expect(pingMentions(null)).toEqual({ parse: [] });
    expect(pingMentions('everyone')).toEqual({ parse: ['everyone'] });
    expect(pingMentions('42')).toEqual({ parse: [], roles: ['42'] });
    expect(pingLabel('42', new Map([['42', 'Minecraft']]))).toBe('@Minecraft');
    expect(pingLabel('everyone', new Map())).toBe('@everyone');
    expect(pingLabel(null, new Map())).toBeNull();
    const id = await createAnnouncement(db(), { title: 'Ping', body_md: 'x', author_id: 'board', source: 'web', draft: true, ping: 'everyone' }, NOW);
    expect((await getAnnouncement(db(), id))?.ping).toBe('everyone');
    expect((await updateAnnouncement(db(), id, { title: 'Ping', body_md: 'x', ping: '42' }))?.ping).toBe('42');
    expect((await updateAnnouncement(db(), id, { title: 'Ping', body_md: 'y' }))?.ping).toBe('42'); // untouched when not sent
    expect((await updateAnnouncement(db(), id, { title: 'Ping', body_md: 'y', publish_at: NOW + 3600 }))?.publish_at).toBe(NOW + 3600);
    expect((await updateAnnouncement(db(), id, { title: 'Ping', body_md: 'y', publish_at: null }))?.publish_at).toBeNull();
  });

  it('stores, versions, attaches and removes a cover', async () => {
    const id = await createAnnouncement(db(), { title: 'SMP', body_md: 'Open!', author_id: 'board', source: 'web', draft: false }, NOW);
    expect((await listAnnouncements(db()))[0].cover_at).toBeNull();
    expect(await newsCoverFile(db(), id)).toBeNull();
    await setAnnouncementCover(db(), id, 'image/png', PNG.buffer.slice(0), NOW + 10);
    expect((await listAnnouncements(db()))[0].cover_at).toBe(NOW + 10);
    expect((await getAnnouncementCover(db(), id))?.bytes.byteLength).toBe(PNG.length);
    const file = await newsCoverFile(db(), id);
    expect(file?.name).toBe(`news-${id}.png`);
    expect(file?.bytes.length).toBe(PNG.length);
    expect(newsText({ title: 'SMP', body_md: 'Open!' })).toBe('📣 **SMP**\nOpen!');
    // Discord takes 2000 characters a message: a long post goes in parts, whole paragraphs
    // per part, the ping and the title on the first.
    const paragraph = 'Words and more words for the members to read, over and over. ';
    const long = Array.from({ length: 8 }, (_, i) => `**Part ${i + 1}.** ${paragraph.repeat(6)}`.trim()).join('\n\n');
    expect(long.length).toBeGreaterThan(2500);
    const parts = newsParts({ title: 'Long one', body_md: long, ping: 'everyone' });
    expect(parts.length).toBe(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(2000);
    expect(parts[0].startsWith('@everyone 📣 **Long one**\n**Part 1.**')).toBe(true);
    expect(parts[1].startsWith('**Part ')).toBe(true);
    expect(parts.join('\n\n')).toContain('**Part 8.**');
    for (const part of parts) expect(part.endsWith('.')).toBe(true);
    // A paragraph longer than a message is cut at spaces, never mid-word.
    const wall = 'word '.repeat(900).trim();
    const walls = newsParts({ title: 'Wall', body_md: wall, ping: null });
    expect(walls.length).toBe(3);
    for (const part of walls) {
      expect(part.length).toBeLessThanOrEqual(2000);
      expect(part.endsWith('word')).toBe(true);
    }
    expect(walls.join(' ').split('word').length - 1).toBe(900);
    expect(newsParts({ title: 'Empty', body_md: '', ping: null })).toEqual(['📣 **Empty**\n']);
    // The ids kept per post: the new shape, and the one message of a post from before.
    expect(newsMessages({ discord_message_id: '1', discord_messages: '{"image":"9","parts":["1","2"]}' })).toEqual({ image: '9', parts: ['1', '2'], legacy: false });
    expect(newsMessages({ discord_message_id: '1', discord_messages: null })).toEqual({ image: null, parts: ['1'], legacy: true });
    expect(newsMessages({ discord_message_id: null, discord_messages: null })).toBeNull();
    expect(newsMessages({ discord_message_id: '1', discord_messages: 'not json' })).toEqual({ image: null, parts: ['1'], legacy: true });
    await expect(setAnnouncementCover(db(), id, 'text/plain', PNG.buffer.slice(0), NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(setAnnouncementCover(db(), id, 'image/png', new ArrayBuffer(COVER_MAX_BYTES + 1), NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(setAnnouncementCover(db(), id + 99, 'image/png', PNG.buffer.slice(0), NOW)).rejects.toMatchObject({ code: 'missing' });
    // Editing keeps the rest of the row and refuses an empty post.
    expect((await updateAnnouncement(db(), id, { title: ' SMP is open ', body_md: 'Come play' }))?.title).toBe('SMP is open');
    expect((await getAnnouncement(db(), id))?.body_md).toBe('Come play');
    await expect(updateAnnouncement(db(), id, { title: '', body_md: 'x' })).rejects.toMatchObject({ code: 'bad_input' });
    expect(await updateAnnouncement(db(), id + 99, { title: 'x', body_md: 'y' })).toBeNull();
    expect(await deleteAnnouncementCover(db(), id)).toBe(true);
    expect(await deleteAnnouncementCover(db(), id)).toBe(false);
    await setAnnouncementCover(db(), id, 'image/png', PNG.buffer.slice(0), NOW + 20);
    expect((await deleteAnnouncement(db(), id))?.id).toBe(id);
    expect(await getAnnouncement(db(), id)).toBeNull();
    expect(await getAnnouncementCover(db(), id)).toBeNull();
  });
});

describe('unpublishing', () => {
  it('makes a published post a draft again and forgets its Discord messages', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO members (discord_id, username, last_seen) VALUES ('100000000000000009', 'Aino', 1)").run();
    const id = await createAnnouncement(env.DB, { title: 'Hello', body_md: 'World', author_id: '100000000000000009', source: 'web', draft: true, ping: 'everyone' }, 10);
    expect(await unpublishAnnouncement(env.DB, id)).toBeNull(); // a draft already
    await publishAnnouncement(env.DB, id, 20);
    await setAnnouncementMessages(env.DB, id, { image: '9', parts: ['1', '2'] });
    const was = await unpublishAnnouncement(env.DB, id);
    expect(newsMessages(was!)).toEqual({ image: '9', parts: ['1', '2'], legacy: false });
    const after = await getAnnouncement(env.DB, id);
    expect(after).toMatchObject({ draft: 1, publish_at: null, discord_message_id: null, discord_messages: null, ping: 'everyone' });
    expect(await unpublishAnnouncement(env.DB, id)).toBeNull();
  });
});
