import type { D1Database } from '@cloudflare/workers-types';
import { getSettings, setSetting } from './db';
import { fetchWebhookChannel, createChannelMessage, postWebhook, NO_MENTIONS, SUPPRESS_EMBEDS } from './discord';

// The board's channel: the one behind BOARD_WEBHOOK_URL, found once and
// kept in settings. Lines that carry buttons (approve / decline) go there
// by the bot, since a webhook cannot carry buttons; without the bot, or
// when it cannot post there, the webhook takes the line without them.

export interface BoardEnv {
  DISCORD_BOT_TOKEN?: string;
  BOARD_WEBHOOK_URL?: string;
}

export async function boardChannel(db: D1Database, env: BoardEnv): Promise<string | null> {
  if (!env.BOARD_WEBHOOK_URL) return null;
  const saved = (await getSettings(db)).board_channel_id;
  if (saved) return saved;
  const found = await fetchWebhookChannel(env.BOARD_WEBHOOK_URL);
  if (found) await setSetting(db, 'board_channel_id', found, 'bot', Math.floor(Date.now() / 1000));
  return found;
}

export async function postBoardLine(db: D1Database, env: BoardEnv, content: string, components: unknown[] = []): Promise<boolean> {
  if (env.DISCORD_BOT_TOKEN) {
    const channel = await boardChannel(db, env);
    if (channel) {
      const made = await createChannelMessage(env.DISCORD_BOT_TOKEN, channel, content, NO_MENTIONS, SUPPRESS_EMBEDS, components);
      if (made.ok) return true;
      console.log(`board channel: the bot could not post (${made.reason}); webhook without buttons`);
    }
  }
  if (!env.BOARD_WEBHOOK_URL) return false;
  return (await postWebhook(env.BOARD_WEBHOOK_URL, content, NO_MENTIONS, SUPPRESS_EMBEDS)) !== null;
}

// Approve / Decline under a board line. The custom id carries what it is
// about: "w" a whitelist friend (the name), "a" an actives request (the
// register id). Any board member may press them.
export function approveButtons(kind: 'w' | 'a', key: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Approve', custom_id: `${kind}:ok:${key}` },
        { type: 2, style: 4, label: 'Decline', custom_id: `${kind}:no:${key}` },
      ],
    },
  ];
}

// The line once someone pressed: the original text with the outcome under it.
export function decidedLine(original: string, outcome: string): string {
  const base = original.split('\n').filter((l) => !/^(✅|❌) /.test(l)).join('\n');
  return `${base}\n${outcome}`;
}
