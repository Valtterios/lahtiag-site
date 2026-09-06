// node scripts/handbook/mint.mjs — throwaway cookies for the screenshots,
// sealed like src/lib/auth.ts and src/lib/board.ts with the dummy
// SESSION_SECRET below, which must also be in .dev.vars. Local only; the
// personas are the made-up people from seed.py.
import { writeFileSync } from 'node:fs';
const secret = 'local-dev-only-session-secret-not-used-anywhere-else';
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
async function seal(obj, keyMaterial) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}
const now = Math.floor(Date.now() / 1000);
const session = (discordId, username, handle, isAdmin) => ({ discordId, username, handle, avatarHash: null, isAdmin, accessToken: 'local-dummy', expiresAt: now + 23 * 3600 });
const out = {
  admin: await seal(session('100000000000000001', 'Aino', 'aino.v', true), secret),
  member: await seal(session('100000000000000002', 'Mikko', 'mikko_l', false), secret),
  ben: await seal(session('100000000000000003', 'Ben', 'benk', false), secret),
  sara: await seal(session('100000000000000006', 'Sara', 'sarak', false), secret),
  board: await seal({ email: 'aino.virtanen@lahtiag.fi', expiresAt: now + 7 * 3600 }, `${secret}\nregister-board-session`),
};
writeFileSync(new URL('./cookies.json', import.meta.url), JSON.stringify(out));
console.log('cookies written');
