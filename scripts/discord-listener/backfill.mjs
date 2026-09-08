#!/usr/bin/env node
// A one-off walk backwards through the LahtiAG server's message history,
// for everything written before the listener started counting. The
// listener (listener.mjs) walks forward from the season's 1 September, so
// nothing older than that was ever counted, and a member's all-time
// figure on their card was really "this season". This fills that in.
//
// It counts exactly what the listener counts — messages by people, in the
// channels every member can see, per member and day and per channel and
// day, never a word of content — and posts them to the same endpoint in
// the same batches. It only ever looks at messages OLDER than the
// boundary (1 September by default), which is where the listener's own
// counting begins, so nothing is counted twice.
//
// Voice has no history to walk: minutes before the listener existed are
// gone for good, and this brings back messages only.
//
// Run it on auraserver, where the token is:
//   docker run --rm --env-file /opt/lahtiag-listener/.env \
//     -v /opt/lahtiag-listener/state:/state -v /opt/lahtiag-listener:/app \
//     node:22-alpine node /app/backfill.mjs --dry-run
// Drop --dry-run to post the counts. Progress is saved after every page,
// so it can be stopped and started again; a channel already walked is not
// walked twice. See docs/OPERATIONS.md, "The Discord activity listener".

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const TOKEN = need('DISCORD_BOT_TOKEN');
const GUILD = need('DISCORD_GUILD_ID');
const ACTIVITY_URL = need('ACTIVITY_URL');
const ACTIVITY_TOKEN = need('ACTIVITY_TOKEN');
const MEMBER_ROLE = process.env.MEMBER_ROLE_ID || null;
const COUNT_CHANNELS = process.env.COUNT_CHANNELS ?? 'public';
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const API = 'https://discord.com/api/v10';
const UA = 'lahtiag-listener/1 (https://lahtiag.fi)';
const COUNTED_TYPES = new Set([0, 19]); // ordinary messages and replies
const VIEW_CHANNEL = 1n << 10n;
const PUSH_AT = 4000; // rows held before a batch goes out

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const BEFORE_GIVEN = value('--before'); // the boundary itself waits for the day helpers below
const RESET = args.includes('--reset');

function value(flag) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : null;
}
function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- days and snowflakes, the listener's own ---------------------------------------
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (date) => dayFormat.format(date);
const DISCORD_EPOCH = 1420070400000n;
const snowflakeAt = (date) => String((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n);

// Midnight in Helsinki on that date, whatever the offset is that day.
function helsinkiMidnight(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Helsinki', timeZoneName: 'longOffset' })
    .formatToParts(new Date(utc))
    .find((p) => p.type === 'timeZoneName').value;
  const parts = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const offset = parts ? (parts[1] === '-' ? -1 : 1) * (Number(parts[2]) * 3600 + Number(parts[3]) * 60) * 1000 : 0;
  return new Date(utc - offset);
}
// Where the listener's own counting starts: 1 September of this season.
function defaultBoundary() {
  const [y, m] = dayOf(new Date()).split('-').map(Number);
  return `${m >= 9 ? y : y - 1}-09-01`;
}
const BEFORE = BEFORE_GIVEN ?? defaultBoundary();

// --- state, so a stopped walk carries on where it left off ------------------------
mkdirSync(STATE_DIR, { recursive: true });
// A dry run keeps its own progress, so it cannot leave the real one
// thinking the work is already done.
const STATE_FILE = join(STATE_DIR, DRY ? 'backfill.dry.json' : 'backfill.json');
const state = load();
function load() {
  if (existsSync(STATE_FILE) && !RESET) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch (error) {
      console.error('the saved progress is unreadable; refusing to start over on its own:', error.message);
      console.error('pass --reset to walk everything again (which would count it all a second time).');
      process.exit(2);
    }
  }
  return { instance: `back-${randomBytes(6).toString('hex')}`, seq: 1, cursors: {}, pending: {}, channelPending: {}, counted: 0 };
}
function save() {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}
function add(userId, day, n) {
  const row = (state.pending[`${userId}|${day}`] ??= { messages: 0, voice_minutes: 0 });
  row.messages += n;
}
function addChannel(channelId, name, day, n) {
  const row = (state.channelPending[`${channelId}|${day}`] ??= { name, messages: 0, voice_minutes: 0 });
  row.name = name;
  row.messages += n;
}
const pendingRows = () => Object.keys(state.pending).length + Object.keys(state.channelPending).length;

// --- Discord REST, with its rate limits respected -----------------------------------
async function rest(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(API + path, { headers: { authorization: `Bot ${TOKEN}`, 'user-agent': UA } });
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const wait = Math.min(60, Number(body.retry_after ?? response.headers.get('retry-after') ?? 1));
      log('rate limited, waiting', wait, 's');
      await sleep(wait * 1000);
      continue;
    }
    if (response.status >= 500) {
      await response.text().catch(() => {});
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      await sleep(Number(response.headers.get('x-ratelimit-reset-after') ?? 1) * 1000);
    }
    return response;
  }
  throw new Error(`Discord kept failing on ${path}`);
}

// --- which channels count: the listener's rule, unchanged --------------------------
let everyoneBase = VIEW_CHANNEL;
function visibleToMembers(channel) {
  if (COUNT_CHANNELS === 'all') return true;
  const overwrite = (id) => (channel.permission_overwrites ?? []).find((o) => o.id === id);
  const has = (o, field) => Boolean(o && (BigInt(o[field]) & VIEW_CHANNEL));
  const member = MEMBER_ROLE ? overwrite(MEMBER_ROLE) : null;
  const everyone = overwrite(GUILD);
  if (has(member, 'allow')) return true;
  if (has(member, 'deny')) return false;
  if (has(everyone, 'allow')) return true;
  if (has(everyone, 'deny')) return false;
  return Boolean(everyoneBase & VIEW_CHANNEL);
}

// Everywhere people wrote that counts: the channels, their voice chats,
// and the threads inside them — the archived ones too, which is where an
// old conversation ends up and which the live listener never revisits.
async function placesToWalk() {
  const roles = await rest(`/guilds/${GUILD}/roles`);
  if (roles.ok) {
    const everyone = (await roles.json()).find((r) => r.id === GUILD);
    if (everyone) everyoneBase = BigInt(everyone.permissions);
  }
  const response = await rest(`/guilds/${GUILD}/channels`);
  if (!response.ok) throw new Error(`channel list ${response.status}`);
  const parents = new Map();
  for (const c of await response.json()) {
    if (!visibleToMembers(c)) continue;
    if ([0, 5, 2, 13].includes(c.type)) parents.set(c.id, c.name);
  }
  const out = [...parents].map(([id, name]) => ({ id, name, statsId: id, statsName: name }));
  const seen = new Set(parents.keys());

  const active = await rest(`/guilds/${GUILD}/threads/active`);
  if (active.ok) {
    for (const t of (await active.json()).threads ?? []) {
      if (t.type === 12 || seen.has(t.id) || !parents.has(t.parent_id)) continue;
      seen.add(t.id);
      out.push({ id: t.id, name: `${parents.get(t.parent_id)} › ${t.name}`, statsId: t.parent_id, statsName: parents.get(t.parent_id) });
    }
  }
  for (const [parentId, parentName] of parents) {
    let before = null;
    for (let page = 0; page < 20; page++) {
      const threads = await rest(`/channels/${parentId}/threads/archived/public?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (!threads.ok) break;
      const data = await threads.json();
      for (const t of data.threads ?? []) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push({ id: t.id, name: `${parentName} › ${t.name}`, statsId: parentId, statsName: parentName });
        before = t.thread_metadata?.archive_timestamp ?? before;
      }
      if (!data.has_more) break;
    }
  }
  return out;
}

// --- posting to the site, in the batches it applies once ---------------------------
async function push(force = false) {
  if (DRY) return;
  if (!force && pendingRows() < PUSH_AT) return;
  while (pendingRows() > 0) {
    const rows = Object.entries(state.pending).slice(0, 5000).map(([key, d]) => ({ key, discord_id: key.split('|')[0], day: key.split('|')[1], messages: d.messages, voice_minutes: 0 }));
    const channelRows = Object.entries(state.channelPending).slice(0, 5000).map(([key, d]) => ({ key, channel_id: key.split('|')[0], name: d.name, day: key.split('|')[1], messages: d.messages, voice_minutes: 0 }));
    const seq = state.seq;
    const response = await fetch(ACTIVITY_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${ACTIVITY_TOKEN}`, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({
        instance: state.instance,
        seq,
        deltas: rows.map(({ key, ...d }) => d),
        channel_deltas: channelRows.map(({ key, ...d }) => d),
      }),
    });
    if (!response.ok) {
      log('push refused', response.status, (await response.text()).slice(0, 200));
      throw new Error('the site would not take the batch');
    }
    const body = await response.json().catch(() => ({}));
    for (const row of rows) delete state.pending[row.key];
    for (const row of channelRows) delete state.channelPending[row.key];
    state.seq = seq + 1;
    save();
    log('pushed', rows.length, 'member rows and', channelRows.length, 'channel rows as batch', seq, body.duplicate ? '(the site had it already)' : '');
  }
}

// --- the walk ----------------------------------------------------------------------
async function walk() {
  const boundary = helsinkiMidnight(BEFORE);
  const wall = snowflakeAt(boundary);
  log(DRY ? 'dry run:' : 'counting:', 'everything written before', BEFORE, `(${boundary.toISOString()})`);
  const places = await placesToWalk();
  log('walking', places.length, 'channels and threads back through their history');

  for (const place of places) {
    if (state.cursors[place.id] === 'done') continue;
    let before = state.cursors[place.id] ?? wall;
    let here = 0;
    let oldest = null;
    for (let page = 0; page < 5000; page++) {
      const response = await rest(`/channels/${place.id}/messages?before=${before}&limit=100`);
      if (response.status === 403 || response.status === 404) {
        await response.text().catch(() => {});
        break; // not ours to read, or gone
      }
      if (!response.ok) {
        log('messages in', place.name, response.status);
        break;
      }
      const messages = await response.json();
      if (messages.length === 0) break;
      messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // newest first
      for (const m of messages) {
        if (BigInt(m.id) >= BigInt(wall)) continue; // the listener's own ground
        if (m.author?.bot || !COUNTED_TYPES.has(m.type)) continue;
        const day = dayOf(new Date(m.timestamp));
        add(m.author.id, day, 1);
        addChannel(place.statsId, place.statsName, day, 1);
        here++;
        state.counted++;
        oldest = day;
      }
      before = messages[messages.length - 1].id;
      state.cursors[place.id] = before;
      save();
      await push();
      if (messages.length < 100) break;
    }
    state.cursors[place.id] = 'done';
    save();
    if (here > 0) log(`#${place.name}: ${here} messages, back to ${oldest}`);
  }
  await push(true);
  log('done:', state.counted, 'messages counted before', BEFORE);
  if (DRY) {
    const perDay = new Map();
    for (const [key, d] of Object.entries(state.pending)) {
      const month = key.split('|')[1].slice(0, 7);
      perDay.set(month, (perDay.get(month) ?? 0) + d.messages);
    }
    for (const month of [...perDay.keys()].sort()) log('  ', month, perDay.get(month));
    log('nothing was posted (dry run); the real run keeps its own progress in backfill.json.');
  }
}

walk().catch((error) => {
  console.error(error);
  process.exit(1);
});
