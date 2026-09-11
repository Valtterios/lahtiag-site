#!/usr/bin/env node
// The Minecraft chat bridge for a LahtiAG server, and the GT:NH progress
// tracker. Three jobs, all from the server's own files and the AMP API on
// the host, no mod on the server:
//   - the server log's chat, joins and leaves, achievements and the
//     server coming up or going down go to a Discord channel through a
//     webhook, each player under their own name and skin face;
//   - messages written in that channel go into the game as
//     "[Discord] Name: text" through the instance's AMP console
//     (needs the Message Content intent on the bot);
//   - every few minutes the quest book's per-player progress
//     (<world>/betterquesting) is counted per tier chapter and posted to
//     the site (POST /api/minecraft/progress); the site decides the tier,
//     and a tier reached is announced in the channel.
// Plain Node 22+ (built-in WebSocket and fetch), no dependencies. Runs on
// auraserver in Docker next to the activity listener; see compose.yaml
// and setcreds next to this file, and docs/OPERATIONS.md, "The Minecraft
// chat bridge".

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `--dry-run` reads the quest book, prints what would be sent, and stops:
// a check of the counting without tokens or a channel.
const DRY = process.argv.includes('--dry-run');
const TOKEN = need('DISCORD_BOT_TOKEN');
const CHANNEL = need('BRIDGE_CHANNEL_ID');
const WEBHOOK = need('BRIDGE_WEBHOOK_URL');
const MC_DIR = process.env.MC_DIR ?? '/mc';
const SERVER = process.env.SERVER ?? 'gtnh'; // the site's slug for this server
const LABEL = process.env.SERVER_LABEL ?? 'GT:NH';
const SITE_URL = (process.env.SITE_URL ?? 'https://lahtiag.fi').replace(/\/$/, '');
const SITE_TOKEN = process.env.SITE_TOKEN ?? ''; // the whitelist token; without it progress stays local
const AMP_URL = (process.env.AMP_URL ?? '').replace(/\/$/, '');
const AMP_USER = process.env.AMP_USER ?? '';
const AMP_PASS = process.env.AMP_PASS ?? '';
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const PROGRESS_EVERY = Number(process.env.PROGRESS_EVERY ?? 300) * 1000;
const TAIL_EVERY = Number(process.env.TAIL_EVERY ?? 1000);
const MAX_TO_GAME = 240; // characters of a Discord message that go in-game
const API = 'https://discord.com/api/v10';
const UA = 'lahtiag-bridge/1 (https://lahtiag.fi)';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT (privileged: turn it on in the developer portal)

function need(name) {
  const value = process.env[name];
  if (!value && DRY) return '';
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
}
const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- state: the tiers last seen, so a tier reached is said once ---------------------
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
  return { tiers: {}, mtimes: {} };
}
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}

// --- players: name to UUID from the server's own cache -----------------------------
const uuids = new Map(); // lower-case name -> uuid
function loadUserCache() {
  try {
    for (const row of JSON.parse(readFileSync(join(MC_DIR, 'usercache.json'), 'utf8'))) {
      if (row?.name && row?.uuid) uuids.set(row.name.toLowerCase(), row.uuid.toLowerCase());
    }
  } catch {
    // the file appears after the first player
  }
}
loadUserCache();
const faceOf = (name) => {
  const uuid = uuids.get(name.toLowerCase());
  return uuid ? `${SITE_URL}/membership/minecraft/face/${uuid}` : undefined;
};

// --- to Discord: the webhook, one message at a time, its rate limit respected -------
const outbox = [];
let sending = false;
function say(content, username = LABEL, avatar = undefined) {
  if (!content) return;
  const last = outbox[outbox.length - 1];
  if (last && last.username === username && last.avatar === avatar && last.content.length + content.length < 1800) {
    last.content += `\n${content}`; // the same voice twice in a row: one message
  } else {
    outbox.push({ content, username, avatar });
  }
  void drain();
}
async function drain() {
  if (sending) return;
  sending = true;
  try {
    while (outbox.length > 0) {
      const next = outbox[0];
      const body = { content: next.content.slice(0, 1900), username: next.username, allowed_mentions: { parse: [] }, ...(next.avatar ? { avatar_url: next.avatar } : {}) };
      const response = await fetch(`${WEBHOOK}?wait=false`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(body) });
      if (response.status === 429) {
        const data = await response.json().catch(() => ({}));
        await sleep(Math.min(60, Number(data.retry_after ?? 2)) * 1000);
        continue;
      }
      await response.text().catch(() => {});
      if (!response.ok && response.status !== 404) log('webhook', response.status);
      outbox.shift();
      if (response.headers.get('x-ratelimit-remaining') === '0') await sleep(Number(response.headers.get('x-ratelimit-reset-after') ?? 1) * 1000);
      else await sleep(350);
    }
  } catch (error) {
    log('webhook failed:', error.message);
    outbox.length = 0; // chat is not worth a backlog
  } finally {
    sending = false;
  }
}

// Minecraft chat as Discord text: colour codes gone, Markdown kept quiet.
const escapeMd = (text) => text.replace(/§./g, '').replace(/([\\*_~`|>])/g, '\\$1');

// --- from the log: chat, joins, achievements, the server up or down ------------------
const LOG = join(MC_DIR, 'logs', 'latest.log');
const LINE = /^\[\d\d:\d\d:\d\d\] \[[^\]]+\/INFO\]: (.*)$/;
const NAME = '[A-Za-z0-9_]{1,16}';
const CHAT = new RegExp(`^<(${NAME})> (.*)$`);
const JOIN = new RegExp(`^(${NAME}) (joined|left) the game$`);
const ACHIEVEMENT = new RegExp(`^(${NAME}) has just earned the achievement \\[(.+)\\]$`);
const UUID_LINE = new RegExp(`^UUID of player (${NAME}) is ([0-9a-f-]{36})$`);
let tail = { ino: null, position: 0, rest: '' };

function tailLog() {
  let stat;
  try {
    stat = statSync(LOG);
  } catch {
    return; // no log while the server is being set up
  }
  if (tail.ino === null) {
    // First sight: start at the end; what was said before the bridge is not repeated.
    tail = { ino: stat.ino, position: stat.size, rest: '' };
    return;
  }
  if (stat.ino !== tail.ino || stat.size < tail.position) tail = { ino: stat.ino, position: 0, rest: '' }; // a new log after a restart
  if (stat.size === tail.position) return;
  const fd = openSync(LOG, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - tail.position);
    const read = readSync(fd, buffer, 0, buffer.length, tail.position);
    tail.position += read;
    const text = tail.rest + buffer.toString('utf8', 0, read);
    const lines = text.split('\n');
    tail.rest = lines.pop() ?? '';
    for (const line of lines) onLogLine(line.replace(/\r$/, ''));
  } finally {
    closeSync(fd);
  }
}

function onLogLine(line) {
  const m = LINE.exec(line);
  if (!m) return;
  const text = m[1];
  let x;
  if ((x = CHAT.exec(text))) return say(escapeMd(x[2]), x[1], faceOf(x[1]));
  if ((x = JOIN.exec(text))) return say(`${x[2] === 'joined' ? '➡️' : '⬅️'} **${x[1]}** ${x[2]} the game`);
  if ((x = ACHIEVEMENT.exec(text))) return say(`🏆 **${x[1]}** earned the achievement **${escapeMd(x[2])}**`);
  if ((x = UUID_LINE.exec(text))) return void uuids.set(x[1].toLowerCase(), x[2].toLowerCase());
  if (/^Done \(/.test(text)) return say(`🟢 The ${LABEL} server is up`);
  if (/^Stopping the server/.test(text)) return say(`🔴 The ${LABEL} server is going down`);
  if (/^\[Server\] /.test(text)) return say(escapeMd(text.slice(9)), 'Server');
}

// --- into the game: the AMP console -------------------------------------------------
let ampSession = null;
async function amp(endpoint, payload) {
  const response = await fetch(`${AMP_URL}/API/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) });
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
async function ampLogin() {
  const answer = await amp('Core/Login', { username: AMP_USER, password: AMP_PASS, token: '', rememberMe: false });
  if (!answer.success || !answer.sessionID) throw new Error(`AMP login failed: ${answer.resultReason ?? JSON.stringify(answer)}`);
  ampSession = answer.sessionID;
}
async function console_(message) {
  if (!AMP_URL || !AMP_USER || !AMP_PASS) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!ampSession) await ampLogin();
      const status = await amp('Core/GetStatus', { SESSIONID: ampSession });
      if (status.State === undefined) throw new Error('session gone');
      if (Number(status.State) !== 20) return false; // not Ready: the server is off or starting
      await amp('Core/SendConsoleMessage', { SESSIONID: ampSession, message });
      return true;
    } catch (error) {
      ampSession = null;
      if (attempt === 1) log('AMP:', error.message);
    }
  }
  return false;
}

// A Discord message as game text: mentions as names, emoji as :names:,
// attachments named, one line, not too long.
function gameText(message) {
  let text = (message.content ?? '')
    .replace(/<@!?(\d+)>/g, (_m, id) => `@${message.mentions?.find((u) => u.id === id)?.global_name ?? message.mentions?.find((u) => u.id === id)?.username ?? 'someone'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\s+/g, ' ')
    .trim();
  const files = message.attachments?.length ?? 0;
  if (files > 0) text = `${text} [${files === 1 ? 'a file' : `${files} files`}]`.trim();
  if (message.sticker_items?.length) text = `${text} [sticker]`.trim();
  return text.length > MAX_TO_GAME ? `${text.slice(0, MAX_TO_GAME - 1)}…` : text;
}

async function toGame(message) {
  const text = gameText(message);
  if (!text) return;
  const name = message.member?.nick ?? message.author?.global_name ?? message.author?.username ?? 'someone';
  const parts = ['', { text: '[Discord] ', color: 'blue' }, { text: name, color: 'aqua' }, { text: `: ${text}`, color: 'white' }];
  const sent = await console_(`tellraw @a ${JSON.stringify(parts)}`);
  if (!sent) log('not delivered in-game (server not ready or AMP not set):', name);
}

// --- the gateway, for the channel's messages ----------------------------------------
let ws = null;
let heartbeat = null;
let seqNo = null;
let sessionId = null;
let resumeUrl = null;
let acked = true;
let backoff = 1000;
let me = null;

function connect(resume) {
  const base = resume && resumeUrl ? resumeUrl : 'wss://gateway.discord.gg';
  ws = new WebSocket(`${base}/?v=10&encoding=json`);
  ws.onmessage = (event) => onGateway(JSON.parse(event.data), resume);
  ws.onerror = (event) => log('gateway error', event.message ?? '');
  ws.onclose = (event) => {
    clearInterval(heartbeat);
    heartbeat = null;
    if ([4004, 4013, 4014].includes(event.code)) {
      console.error('the gateway refused the token or the intents (is Message Content turned on for the bot?); stopping');
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
      else send(2, { token: TOKEN, intents: INTENTS, properties: { os: 'linux', browser: 'lahtiag-bridge', device: 'lahtiag-bridge' } });
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
  switch (type) {
    case 'READY':
      sessionId = d.session_id;
      resumeUrl = d.resume_gateway_url;
      backoff = 1000;
      me = d.user?.id ?? null;
      log('gateway ready as', d.user?.username, '· bridging channel', CHANNEL, 'to', LABEL);
      break;
    case 'RESUMED':
      backoff = 1000;
      log('gateway resumed');
      break;
    case 'MESSAGE_CREATE':
      if (d.channel_id !== CHANNEL) return;
      if (d.author?.bot || d.webhook_id || d.author?.id === me) return; // the game's own lines come back through the webhook
      if (![0, 19].includes(d.type)) return;
      void toGame(d);
      break;
  }
}

// --- progress: the quest book's chapters per player ---------------------------------
const BQ = join(MC_DIR, 'world', 'betterquesting');
let chapters = { mtime: 0, byQuest: new Map(), totals: {} }; // quest id -> chapter key; chapter key -> quests

// BetterQuesting's JSON has typed keys ("name:8") and 64-bit ids that a
// JavaScript number cannot hold exactly; the reviver keeps each id's own
// text, so a quest is looked up by the same string on both sides.
function parseBq(text) {
  return JSON.parse(text, function (key, value, context) {
    return typeof value === 'number' && /^questID(High|Low):4$/.test(key) && context?.source ? context.source : value;
  });
}
const questKey = (o) => `${o['questIDHigh:4']}:${o['questIDLow:4']}`;
// "Tier 3 - HV" -> "hv"; "Tier 0 - Stone Age" -> "stone"; other chapters are not tiers.
function chapterKey(name) {
  const m = /^Tier \S+ - (\S+)/.exec(name ?? '');
  return m ? m[1].toLowerCase() : null;
}

function loadChapters() {
  const file = join(BQ, 'QuestDatabase.json');
  const mtime = statSync(file).mtimeMs;
  if (mtime === chapters.mtime) return chapters;
  const db = parseBq(readFileSync(file, 'utf8'));
  const byQuest = new Map();
  const totals = {};
  for (const line of Object.values(db['questLines:9'] ?? {})) {
    const key = chapterKey(line['properties:10']?.['betterquesting:10']?.['name:8']);
    if (!key) continue;
    const quests = Object.values(line['quests:9'] ?? {});
    totals[key] = quests.length;
    for (const q of quests) byQuest.set(questKey(q), key);
  }
  chapters = { mtime, byQuest, totals, quests: Object.keys(db['questDatabase:9'] ?? {}).length };
  log('quest book read:', Object.entries(totals).map(([k, n]) => `${k} ${n}`).join(', '));
  return chapters;
}

function playerNames() {
  const names = new Map(); // uuid -> name
  try {
    for (const row of Object.values(parseBq(readFileSync(join(BQ, 'NameCache.json'), 'utf8'))['nameCache:9'] ?? {})) {
      if (row['uuid:8'] && row['name:8']) names.set(row['uuid:8'].toLowerCase(), row['name:8']);
    }
  } catch {
    // no cache yet
  }
  for (const [name, uuid] of uuids) if (!names.has(uuid)) names.set(uuid, name);
  return names;
}

// One player's counts: quests with a completion entry, per tier chapter.
function readProgress(file, book) {
  const data = parseBq(readFileSync(file, 'utf8'));
  const lines = Object.fromEntries(Object.entries(book.totals).map(([k, total]) => [k, { done: 0, total }]));
  let done = 0;
  for (const q of Object.values(data['questProgress:9'] ?? {})) {
    if (Object.keys(q['completed:9'] ?? {}).length === 0) continue;
    done++;
    const key = book.byQuest.get(questKey(q));
    if (key && lines[key]) lines[key].done++;
  }
  return { lines, quests_done: done, quests_total: book.quests };
}

async function pushProgress(all = false) {
  if (!existsSync(join(BQ, 'QuestDatabase.json'))) return;
  let book;
  try {
    book = loadChapters();
  } catch (error) {
    return log('quest book unreadable:', error.message);
  }
  const names = playerNames();
  const players = [];
  const seen = {};
  for (const file of readdirSync(join(BQ, 'QuestProgress'))) {
    const uuid = file.replace(/\.json$/, '').toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(uuid) || !names.has(uuid)) continue;
    const path = join(BQ, 'QuestProgress', file);
    const mtime = statSync(path).mtimeMs;
    seen[uuid] = mtime;
    if (!all && state.mtimes[uuid] === mtime && book.mtime === state.bookMtime) continue; // nothing new for this player
    try {
      players.push({ uuid, name: names.get(uuid), ...readProgress(path, book) });
    } catch (error) {
      log('progress unreadable for', names.get(uuid), error.message);
    }
  }
  if (DRY) {
    console.log(JSON.stringify({ server: SERVER, players }, null, 1));
    process.exit(0);
  }
  if (players.length === 0) return;
  if (!SITE_TOKEN) return log('progress read for', players.length, 'players; no SITE_TOKEN, so not sent');
  let answer;
  try {
    const response = await fetch(`${SITE_URL}/api/minecraft/progress`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SITE_TOKEN}`, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ server: SERVER, players }),
    });
    answer = await response.json();
    if (!response.ok || !answer.ok) throw new Error(`${response.status} ${JSON.stringify(answer)}`);
  } catch (error) {
    return log('the site did not take the progress, will retry:', error.message);
  }
  for (const p of players) {
    state.mtimes[p.uuid] = seen[p.uuid];
    const now = answer.tiers?.[p.uuid];
    if (!now) continue;
    // Said once per tier, and only for a step up the site saw too; the
    // first sighting of a player is a baseline, not news.
    if (now.up && state.tiers[p.uuid] !== now.tier) {
      const line = p.lines[now.tier];
      say(`⚡ **${p.name}** reached **${now.label}** on ${LABEL}${line ? ` · ${line.done} of ${line.total} ${now.label.split(' ')[0]} quests done` : ''}`);
    }
    state.tiers[p.uuid] = now.tier;
  }
  state.bookMtime = book.mtime;
  saveState();
  log('progress sent for', players.length, 'players');
}

// --- run ------------------------------------------------------------------------------
if (DRY) {
  await pushProgress(true);
  process.exit(0);
}
tailLog();
setInterval(tailLog, TAIL_EVERY);
setInterval(loadUserCache, 600_000);
connect(false);
setTimeout(() => void pushProgress(false), 5000); // the state remembers what was sent; a fresh state sends everyone
setInterval(() => void pushProgress(false), PROGRESS_EVERY);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('stopping');
    saveState();
    process.exit(0);
  });
}
