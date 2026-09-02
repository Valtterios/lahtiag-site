import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  editInteractionReply,
  hasAdminRole,
  postWebhook,
  verifyInteractionSignature,
} from '../../lib/discord';
import {
  cancelEvent,
  createAnnouncement,
  createEvent,
  setAnnouncementMessageId,
  setEventMessageId,
  upsertMember,
  RuleError,
} from '../../lib/db';
import { formatHelsinki, helsinkiToUnix } from '../../lib/time';

// The Discord bot: an HTTP Interactions endpoint inside the same Worker
// (spec, Discord bot). No gateway, no second host, same database.

interface Option {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: Option[];
}

interface Interaction {
  type: number;
  application_id: string;
  token: string;
  data?: { name: string; options?: Option[]; resolved?: { users?: Record<string, { id: string; username: string; global_name: string | null; avatar: string | null }> } };
  member?: { roles?: string[]; nick?: string | null; user?: { id: string; username: string; global_name: string | null; avatar: string | null } };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

function optionMap(options: Option[] | undefined): Map<string, string | number | boolean> {
  const map = new Map<string, string | number | boolean>();
  for (const option of options ?? []) {
    if (option.value !== undefined) map.set(option.name, option.value);
  }
  return map;
}

export const POST: APIRoute = async ({ request, locals, url }) => {
  if (!env.DISCORD_PUBLIC_KEY) {
    return new Response('Interactions are not configured.', { status: 503 });
  }

  // Signature first, before the body is even parsed. 401 on failure is also
  // how Discord validates this endpoint when it is first configured.
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  if (
    !signature ||
    !timestamp ||
    !(await verifyInteractionSignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, body))
  ) {
    return new Response('Bad signature.', { status: 401 });
  }

  const interaction = JSON.parse(body) as Interaction;

  if (interaction.type === 1) return json({ type: 1 }); // PING -> PONG

  if (interaction.type !== 2 || !interaction.data) {
    return json({ type: 4, data: { content: 'Unsupported interaction.', flags: 64 } });
  }

  // Acknowledge inside Discord's 3-second budget, do the database work in
  // the background, then edit the reply (spec: otherwise "The application
  // did not respond" even when the write succeeded).
  locals.cfContext.waitUntil(handleCommand(env, interaction, url.origin));
  return json({ type: 5, data: { flags: 64 } }); // deferred, ephemeral
};

async function handleCommand(env: WorkerEnv, interaction: Interaction, origin: string): Promise<void> {
  const reply = (content: string) =>
    editInteractionReply(interaction.application_id, interaction.token, content);

  try {
    const invoker = interaction.member?.user;
    const roles = interaction.member?.roles ?? [];
    if (!invoker) {
      await reply('This command only works inside the LahtiAG server.');
      return;
    }
    // Authorisation reuses the same role check as the web (spec): the
    // payload carries the invoking member's roles.
    if (!hasAdminRole(roles, env.ADMIN_ROLE_ID)) {
      await reply('This command needs the admin role.');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const username = interaction.member?.nick ?? invoker.global_name ?? invoker.username;
    await upsertMember(
      env.DB,
      { discord_id: invoker.id, username, avatar_hash: invoker.avatar },
      now,
    );

    const command = interaction.data!;
    const sub = command.options?.[0];
    const name = sub && sub.type === 1 ? `${command.name} ${sub.name}` : command.name;
    const opts = optionMap(sub && sub.type === 1 ? sub.options : command.options);

    if (name === 'event create') {
      const startsAt = helsinkiToUnix(String(opts.get('date') ?? ''), String(opts.get('time') ?? ''));
      if (startsAt === null) {
        await reply('Date or time did not parse. Use `YYYY-MM-DD` and `HH:MM` (Helsinki time).');
        return;
      }
      const capacity = opts.has('capacity') ? Number(opts.get('capacity')) : null;
      const teamSize = opts.has('team_size') ? Number(opts.get('team_size')) : null;
      const organizers = opts.has('organizers') ? String(opts.get('organizers')) : null;
      const title = String(opts.get('name') ?? '');
      const id = await createEvent(
        env.DB,
        {
          title,
          description: null,
          starts_at: startsAt,
          capacity,
          team_size: teamSize,
          organizers,
          created_by: invoker.id,
        },
        now,
      );
      if (env.DISCORD_WEBHOOK_URL) {
        const byLine = organizers ? `\nOrganized by ${organizers}` : '';
        const teamsLine = teamSize ? `\nTeams of ${teamSize}, form yours on the site!` : '';
        const messageId = await postWebhook(
          env.DISCORD_WEBHOOK_URL,
          `📅 **${title.trim()}**\n${formatHelsinki(startsAt)}${byLine}${teamsLine}\nSign up: ${origin}/events/${id}`,
        );
        if (messageId) await setEventMessageId(env.DB, id, messageId);
      }
      await reply(`Created event #${id}: **${title.trim()}**, ${formatHelsinki(startsAt)}\n${origin}/events/${id}`);
    } else if (name === 'event cancel') {
      const id = Number(opts.get('id'));
      const event = await cancelEvent(env.DB, id, now);
      if (env.DISCORD_WEBHOOK_URL) {
        await postWebhook(
          env.DISCORD_WEBHOOK_URL,
          `❌ Cancelled: **${event.title}** (was ${formatHelsinki(event.starts_at)})`,
        );
      }
      await reply(`Cancelled event #${id}: **${event.title}**.`);
    } else if (name === 'announce') {
      const text = String(opts.get('text') ?? '');
      const title = text.split('\n')[0].replace(/[#*_`>]/g, '').trim().slice(0, 120) || 'Announcement';
      const id = await createAnnouncement(
        env.DB,
        { title, body_md: text, author_id: invoker.id, source: 'discord' },
        now,
      );
      if (env.DISCORD_WEBHOOK_URL) {
        const messageId = await postWebhook(env.DISCORD_WEBHOOK_URL, `📣 ${text}`);
        if (messageId) await setAnnouncementMessageId(env.DB, id, messageId);
      }
      await reply(`Published: **${title}**, ${origin}/announcements`);
    } else {
      await reply(`Unknown command: ${name}.`);
    }
  } catch (error) {
    await reply(error instanceof RuleError ? error.message : 'Something went wrong.');
  }
}
