import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createAnnouncement, listAnnouncements, deleteAnnouncement, getAnnouncement, updateAnnouncement, getAnnouncementCover, setAnnouncementCover, deleteAnnouncementCover, COVER_MAX_BYTES } from '../src/lib/db';
import { newsCoverFile, newsText } from '../src/lib/news';

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
