import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMember, createEvent, deleteEvent, addEventPhoto, listEventPhotos, getEventPhoto, deleteEventPhoto, listPhotoAlbums, PHOTO_MAX_BYTES } from '../src/lib/db';

// Photos in D1: added with a thumbnail, listed, served, removed.

const NOW = 1_760_000_000;
const db = () => env.DB;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

describe('event photos', () => {
  beforeEach(async () => {
    for (const table of ['event_photos', 'events', 'members']) await db().prepare(`DELETE FROM ${table}`).run();
    await upsertMember(db(), { discord_id: 'host', username: 'Host', avatar_hash: null }, NOW);
  });

  it('stores, lists, serves and removes photos, and the album list finds past events', async () => {
    const id = await createEvent(db(), { title: 'LAN', description: null, starts_at: NOW - 86400, capacity: null, created_by: 'host' }, NOW - 90000);
    const a = await addEventPhoto(db(), id, 'image/png', PNG.buffer.slice(0), PNG.buffer.slice(0), NOW);
    const b = await addEventPhoto(db(), id, 'image/png', PNG.buffer.slice(0), null, NOW + 1);
    expect((await listEventPhotos(db(), id)).map((p) => [p.id, p.width, p.height, p.has_thumb])).toEqual([[a, 1, 1, 1], [b, 1, 1, 0]]);
    expect((await getEventPhoto(db(), a, false))?.bytes.byteLength).toBe(PNG.length);
    expect((await getEventPhoto(db(), b, true))?.bytes.byteLength).toBe(PNG.length); // no thumb: the picture itself
    expect(await listPhotoAlbums(db())).toEqual([{ event_id: id, title: 'LAN', starts_at: NOW - 86400, photos: 2, first_id: a }]);
    await expect(addEventPhoto(db(), id, 'text/plain', PNG.buffer.slice(0), null, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(addEventPhoto(db(), id, 'image/png', new ArrayBuffer(PHOTO_MAX_BYTES + 1), null, NOW)).rejects.toMatchObject({ code: 'bad_input' });
    expect(await deleteEventPhoto(db(), id, a)).toBe(true);
    expect(await deleteEventPhoto(db(), id, a)).toBe(false);
    await deleteEvent(db(), id);
    expect(await getEventPhoto(db(), b, false)).toBeNull();
  });
});
