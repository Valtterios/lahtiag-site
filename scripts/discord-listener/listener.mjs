#!/usr/bin/env node
// The Discord activity listener for lahtiag.fi. Counts, per member and
// day (and per channel and day, for statistics), the messages sent and the
// minutes spent in voice on the LahtiAG server, and posts the counts to
// the site (POST /api/discord/activity) in batches the site applies
// exactly once. Never stores or forwards a word
// of content. Two sources:
//   - messages are walked over the REST API, 100 per request, from a
//     cursor per channel (the first run starts at the season's 1 September),
//     so a restart or an outage loses nothing and the season is backfilled;
//   - voice is live from the gateway (VOICE_STATE_UPDATE), credited a
//     minute at a time, because voice has no history to walk.
// Only channels every member can see count (the @everyone role can view
// them, or the Member role is allowed to): not the board channel, not the
// actives channel, not an event's channels. The list of counted channels
// travels with every batch so the site can show it.
// Plain Node 22+ (built-in WebSocket and fetch), no dependencies. Runs on
// auraserver in Docker; see compose.yaml and setcreds next to this file,
// and docs/OPERATIONS.md, "The Discord activity listener".

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const TOKEN = need('DISCORD_BOT_TOKEN');
const GUILD = need('DISCORD_GUILD_ID');
const ACTIVITY_URL = need('ACTIVITY_URL');
const ACTIVITY_TOKEN = need('ACTIVITY_TOKEN');
const MEMBER_ROLE = process.env.MEMBER_ROLE_ID || null; // a channel the Member role may view counts too
const COUNT_CHANNELS = process.env.COUNT_CHANNELS ?? 'public'; // 'public' (every member can see) or 'all'
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const SEASON_START = process.env.SEASON_START; // ISO date; default: 1 September of the current season
const SCAN_EVERY = Number(process.env.SCAN_EVERY ?? 300) * 1000;
const PUSH_EVERY = Number(process.env.PUSH_EVERY ?? 60) * 1000;
const API = 'https://discord.com/api/v10';
const UA = 'lahtiag-listener/1 (https://lahtiag.fi)';
const INTENTS = (1 << 0) | (1 << 7) | (1 << 9); // GUILDS, GUILD_VOICE_STATES, GUILD_MESSAGES: none privileged
const COUNTED_TYPES = new Set([0, 19]); // ordinary messages and replies; not slash commands, joins, pins
const VIEW_CHANNEL = 1n << 10n;

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
}
const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- days and snowflakes ------------------------------------------------------------
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (date) => dayFormat.format(date); // 'YYYY-MM-DD' in Helsinki
function seasonStart() {
  if (SEASON_START) return new Date(SEASON_START);
  const [y, m] = dayOf(new Date()).split('-').map(Number);
  return new Date(Date.UTC(m >= 9 ? y : y - 1, 8, 1) - 3 * 3600 * 1000); // 1 Sept 00:00 Helsinki summer time
}
const DISCORD_EPOCH = 1420070400000n;
const snowflakeAt = (date) => String((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n);

// --- state: pending counts and per-channel cursors, saved together ------------------
mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = join(STATE_DIR, 'state.json');
const state = loadState();
function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch (error) {
      log('state unreadable, starting fresh:', error.message);
    }
  }
  return { instance: randomBytes(8).toString('hex'), seq: 1, cursors: {}, pending: {}, channelPending: {} };
}
let saveTimer = null;
function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}
function save() {
  if (!saveTimer) saveTimer = setTimeout(flush, 1000);
}
function add(userId, day, field, n) {
  if (n <= 0) return;
  const key = `${userId}|${day}`;
  const row = (state.pending[key] ??= { messages: 0, voice_minutes: 0 });
  row[field] += n;
  save();
}
// The same count on the channel's side, for the statistics.
function addChannel(channelId, name, day, field, n) {
  if (n <= 0) return;
  const key = `${channelId}|${day}`;
  const row = ((state.channelPending ??= {})[key] ??= { name, messages: 0, voice_minutes: 0 });
  row.name = name;
  row[field] += n;
  save();
}

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

// --- which channels count ---------------------------------------------------------
let everyoneBase = VIEW_CHANNEL; // the @everyone role's own permissions, refreshed with the channel list
let counted = { text: new Map(), voice: new Map() }; // id -> name, the channels every member can see

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

// Sorts a channel list (from the gateway or the REST API) into the text
// and voice channels that count, and says so when the set changes.
function applyChannels(channels, roles) {
  const everyone = (roles ?? []).find((r) => r.id === GUILD);
  if (everyone) everyoneBase = BigInt(everyone.permissions);
  const text = new Map();
  const voice = new Map();
  for (const c of channels) {
    if (!visibleToMembers(c)) continue;
    if (c.type === 0 || c.type === 5) text.set(c.id, c.name);
    if (c.type === 2 || c.type === 13) voice.set(c.id, c.name);
  }
  const key = (m) => [...m.keys()].sort().join(',');
  if (key(text) !== key(counted.text) || key(voice) !== key(counted.voice)) {
    log('counting in', [...text.values()].map((n) => `#${n}`).join(' ') || '(no text channels)', '| voice:', [...voice.values()].join(', ') || 'none');
  }
  counted = { text, voice };
}

// Every place that counts where people write: the text channels, the
// voice channels' own chats, and the open threads inside those.
async function writableChannels() {
  const roles = await rest(`/guilds/${GUILD}/roles`);
  const channels = await rest(`/guilds/${GUILD}/channels`);
  if (!channels.ok) {
    log('channel list', channels.status);
    return [];
  }
  applyChannels(await channels.json(), roles.ok ? await roles.json() : null);
  const out = [...counted.text, ...counted.voice].map(([id, name]) => ({ id, name, statsId: id, statsName: name }));
  const threads = await rest(`/guilds/${GUILD}/threads/active`);
  if (threads.ok) {
    const data = await threads.json();
    for (const t of data.threads ?? []) {
      if (t.type === 12) continue; // private threads stay private
      const parent = counted.text.get(t.parent_id) ?? counted.voice.get(t.parent_id);
      if (parent) out.push({ id: t.id, name: `${parent} › ${t.name}`, statsId: t.parent_id, statsName: parent }); // a thread counts for its channel
    }
  }
  return out;
}

let scanning = false;
async function scanMessages() {
  if (scanning) return;
  scanning = true;
  try {
    const seasonId = snowflakeAt(seasonStart());
    let counted = 0;
    for (const channel of await writableChannels()) {
      let after = state.cursors[channel.id] ?? seasonId;
      for (let page = 0; page < 500; page++) {
        const response = await rest(`/channels/${channel.id}/messages?after=${after}&limit=100`);
        if (response.status === 403 || response.status === 404) {
          await response.text().catch(() => {});
          break; // not ours to read, or gone
        }
        if (!response.ok) {
          log('messages in', channel.name, response.status);
          break;
        }
        const messages = await response.json();
        if (messages.length === 0) break;
        messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const m of messages) {
          if (m.author?.bot || !COUNTED_TYPES.has(m.type)) continue;
          const day = dayOf(new Date(m.timestamp));
          add(m.author.id, day, 'messages', 1);
          addChannel(channel.statsId, channel.statsName, day, 'messages', 1);
          counted++;
        }
        after = messages[messages.length - 1].id;
        state.cursors[channel.id] = after;
        save();
        if (messages.length < 100) break;
      }
    }
    if (counted > 0) log('counted', counted, 'messages');
  } catch (error) {
    log('scan failed:', error.message);
  } finally {
    scanning = false;
  }
}

// --- the gateway, for voice ----------------------------------------------------------
let ws = null;
let heartbeat = null;
let seqNo = null;
let sessionId = null;
let resumeUrl = null;
let acked = true;
let backoff = 1000;
let afkChannel = null;
const bots = new Set();
const voice = new Map(); // userId -> { channel, credited: ms since epoch up to which minutes were counted }

function connect(resume) {
  const base = resume && resumeUrl ? resumeUrl : 'wss://gateway.discord.gg';
  ws = new WebSocket(`${base}/?v=10&encoding=json`);
  ws.onmessage = (event) => onGateway(JSON.parse(event.data), resume);
  ws.onerror = (event) => log('gateway error', event.message ?? '');
  ws.onclose = (event) => {
    clearInterval(heartbeat);
    heartbeat = null;
    if ([4004, 4013, 4014].includes(event.code)) {
      console.error('the gateway refused the token or the intents; stopping');
      flush();
      process.exit(3);
    }
    const canResume = Boolean(sessionId) && ![4007, 4009, 4010, 4011, 4012].includes(event.code);
    log('gateway closed', event.code, canResume ? 'resuming' : 'reconnecting', 'in', backoff, 'ms');
    setTimeout(() => connect(canResume), backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
}
function send(op, d) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
}
function onGateway(message, resuming) {
  if (message.s) seqNo = message.s;
  switch (message.op) {
    case 10: {
      const interval = message.d.heartbeat_interval;
      clearInterval(heartbeat);
      acked = true;
      heartbeat = setInterval(() => {
        if (!acked) {
          log('heartbeat unanswered, reconnecting');
          ws.close(4000);
          return;
        }
        acked = false;
        send(1, seqNo);
      }, interval);
      setTimeout(() => send(1, seqNo), Math.random() * interval);
      if (resuming && sessionId) send(6, { token: TOKEN, session_id: sessionId, seq: seqNo });
      else send(2, { token: TOKEN, intents: INTENTS, properties: { os: 'linux', browser: 'lahtiag-listener', device: 'lahtiag-listener' } });
      break;
    }
    case 11:
      acked = true;
      break;
    case 1:
      send(1, seqNo);
      break;
    case 7:
      ws.close(4000);
      break;
    case 9:
      if (message.d !== true) {
        sessionId = null;
        seqNo = null;
      }
      setTimeout(() => ws.close(4000), 1000 + Math.random() * 4000);
      break;
    case 0:
      dispatch(message.t, message.d);
      break;
  }
}
function dispatch(type, d) {
  const now = Date.now();
  switch (type) {
    case 'READY':
      sessionId = d.session_id;
      resumeUrl = d.resume_gateway_url;
      backoff = 1000;
      log('gateway ready as', d.user?.username);
      break;
    case 'RESUMED':
      backoff = 1000;
      log('gateway resumed');
      break;
    case 'GUILD_CREATE': {
      if (d.id !== GUILD) break;
      afkChannel = d.afk_channel_id ?? null;
      applyChannels(d.channels ?? [], d.roles ?? null);
      const present = new Set();
      for (const v of d.voice_states ?? []) {
        if (!countsForVoice(v.channel_id)) continue;
        present.add(v.user_id);
        const session = voice.get(v.user_id);
        if (session && session.channel !== v.channel_id) {
          creditVoice(v.user_id, now);
          session.channel = v.channel_id;
        } else if (!session) voice.set(v.user_id, { channel: v.channel_id, credited: now });
      }
      for (const id of [...voice.keys()]) {
        if (present.has(id)) continue;
        creditVoice(id, now);
        voice.delete(id);
      }
      log('in voice now:', voice.size);
      break;
    }
    case 'VOICE_STATE_UPDATE': {
      if (d.guild_id !== GUILD) break;
      const id = d.user_id;
      if (d.member?.user?.bot) {
        bots.add(id);
        break;
      }
      const inVoice = countsForVoice(d.channel_id);
      const session = voice.get(id);
      if (inVoice && !session) voice.set(id, { channel: d.channel_id, credited: now });
      else if (inVoice && session.channel !== d.channel_id) {
        creditVoice(id, now); // the minutes so far go to the room they were spent in
        session.channel = d.channel_id;
      } else if (!inVoice && session) {
        creditVoice(id, now);
        voice.delete(id);
      }
      break;
    }
  }
}
function countsForVoice(channelId) {
  if (!channelId || channelId === afkChannel) return false;
  return COUNT_CHANNELS === 'all' || counted.voice.has(channelId);
}
function creditVoice(id, now) {
  const session = voice.get(id);
  if (!session || bots.has(id)) return;
  const minutes = Math.floor((now - session.credited) / 60_000);
  if (minutes <= 0) return;
  const day = dayOf(new Date(now));
  add(id, day, 'voice_minutes', minutes);
  addChannel(session.channel, counted.voice.get(session.channel) ?? 'voice', day, 'voice_minutes', minutes);
  session.credited += minutes * 60_000;
}
function creditEveryone() {
  const now = Date.now();
  for (const id of voice.keys()) creditVoice(id, now);
}

// --- pushing to the site -------------------------------------------------------------
let pushing = false;
async function push() {
  if (pushing) return;
  pushing = true;
  try {
    const rows = Object.entries(state.pending)
      .filter(([, d]) => d.messages > 0 || d.voice_minutes > 0)
      .slice(0, 5000)
      .map(([key, d]) => {
        const [discord_id, day] = key.split('|');
        return { key, discord_id, day, messages: d.messages, voice_minutes: d.voice_minutes };
      });
    const channelRows = Object.entries(state.channelPending ?? {})
      .filter(([, d]) => d.messages > 0 || d.voice_minutes > 0)
      .slice(0, 5000)
      .map(([key, d]) => {
        const [channel_id, day] = key.split('|');
        return { key, channel_id, name: d.name, day, messages: d.messages, voice_minutes: d.voice_minutes };
      });
    if (rows.length === 0 && channelRows.length === 0) return;
    const seq = state.seq;
    const response = await fetch(ACTIVITY_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${ACTIVITY_TOKEN}`, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({
        instance: state.instance,
        seq,
        deltas: rows.map(({ key, ...delta }) => delta),
        channel_deltas: channelRows.map(({ key, ...delta }) => delta),
        channels: [
          ...[...counted.text].map(([id, name]) => ({ id, name, kind: 'text' })),
          ...[...counted.voice].map(([id, name]) => ({ id, name, kind: 'voice' })),
        ],
      }),
    });
    if (!response.ok) {
      log('push refused', response.status, (await response.text()).slice(0, 160));
      return;
    }
    const body = await response.json().catch(() => ({}));
    // Acknowledged: what was sent is no longer pending. Counts that arrived
    // while the request was out stay for the next batch.
    for (const row of rows) {
      const d = state.pending[row.key];
      if (!d) continue;
      d.messages -= row.messages;
      d.voice_minutes -= row.voice_minutes;
      if (d.messages <= 0 && d.voice_minutes <= 0) delete state.pending[row.key];
    }
    for (const row of channelRows) {
      const d = state.channelPending[row.key];
      if (!d) continue;
      d.messages -= row.messages;
      d.voice_minutes -= row.voice_minutes;
      if (d.messages <= 0 && d.voice_minutes <= 0) delete state.channelPending[row.key];
    }
    state.seq = seq + 1;
    flush();
    log('pushed', rows.length, 'member rows and', channelRows.length, 'channel rows as batch', seq, body.duplicate ? '(the site had it already)' : '');
  } catch (error) {
    log('push failed:', error.message);
  } finally {
    pushing = false;
  }
}

// --- run -------------------------------------------------------------------------------
log('listener', state.instance, 'season from', dayOf(seasonStart()), 'pending rows', Object.keys(state.pending).length);
connect(false);
scanMessages();
setInterval(scanMessages, SCAN_EVERY);
setInterval(creditEveryone, 60_000);
setInterval(push, PUSH_EVERY);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    creditEveryone();
    flush();
    log('stopped');
    process.exit(0);
  });
}
