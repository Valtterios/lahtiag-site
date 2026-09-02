import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  editInteractionReply,
  eventAnnouncement,
  hasAdminRole,
  postWebhook,
  verifyInteractionSignature,
} from '../../lib/discord';
import {
  cancelEvent,
  createAnnouncement,
  createEvent,
  generateBracket,
  getBracket,
  listEventTeams,
  listSignups,
  listUpcomingEvents,
  setAnnouncementMessageId,
  setBracketWinner,
  setEventMessageId,
  setSignupsClosed,
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

interface ModalRow {
  components: { custom_id: string; value?: string }[];
}

interface Interaction {
  type: number;
  application_id: string;
  token: string;
  data?: {
    name?: string;
    options?: Option[];
    custom_id?: string;
    values?: string[];
    components?: ModalRow[];
    resolved?: { users?: Record<string, { id: string; username: string; global_name: string | null; avatar: string | null }> };
  };
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

  const isAdmin = hasAdminRole(interaction.member?.roles ?? [], env.ADMIN_ROLE_ID);

  // /tournament renders the interactive control panel: no database work, so
  // it responds directly instead of deferring.
  if (interaction.type === 2 && interaction.data?.name === 'tournament') {
    if (!isAdmin) {
      return json({ type: 4, data: { content: 'This needs the admin role.', flags: 64 } });
    }
    return json({ type: 4, data: { flags: 64, ...controlPanel() } });
  }

  // Button and select-menu clicks (type 3). Opening a modal must be the
  // immediate response; everything else acks (type 6) and edits the panel
  // message once the work is done.
  if (interaction.type === 3 && interaction.data?.custom_id) {
    if (!isAdmin) {
      return json({ type: 4, data: { content: 'This needs the admin role.', flags: 64 } });
    }
    if (interaction.data.custom_id === 't:create') {
      return json(createEventModal());
    }
    locals.cfContext.waitUntil(handleComponent(env, interaction, url.origin));
    return json({ type: 6 });
  }

  // Modal submits (type 5): defer, create, then edit the reply.
  if (interaction.type === 5 && interaction.data?.custom_id === 't:modal:create') {
    if (!isAdmin) {
      return json({ type: 4, data: { content: 'This needs the admin role.', flags: 64 } });
    }
    locals.cfContext.waitUntil(handleCreateModal(env, interaction, url.origin));
    return json({ type: 5, data: { flags: 64 } });
  }

  if (interaction.type !== 2 || !interaction.data) {
    return json({ type: 4, data: { content: 'Unsupported interaction.', flags: 64 } });
  }

  // Acknowledge inside Discord's 3-second budget, do the database work in
  // the background, then edit the reply (spec: otherwise "The application
  // did not respond" even when the write succeeded).
  locals.cfContext.waitUntil(handleCommand(env, interaction, url.origin));
  return json({ type: 5, data: { flags: 64 } }); // deferred, ephemeral
};

// --- /tournament interactive panel -----------------------------------------

function controlPanel(): { content: string; components: unknown[] } {
  return {
    content: '**Tournament controls** — what needs doing?',
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Create event', custom_id: 't:create', emoji: { name: '📅' } },
          { type: 2, style: 2, label: 'Close signups', custom_id: 't:pick:close', emoji: { name: '🔒' } },
          { type: 2, style: 2, label: 'Reopen signups', custom_id: 't:pick:reopen', emoji: { name: '🔓' } },
          { type: 2, style: 2, label: 'Generate bracket', custom_id: 't:pick:bracket', emoji: { name: '🎲' } },
          { type: 2, style: 3, label: 'Record winner', custom_id: 't:pick:winner', emoji: { name: '🏆' } },
        ],
      },
    ],
  };
}

function createEventModal() {
  const row = (component: Record<string, unknown>) => ({ type: 1, components: [component] });
  return {
    type: 9,
    data: {
      custom_id: 't:modal:create',
      title: 'Create an event',
      components: [
        row({ type: 4, custom_id: 'title', style: 1, label: 'Title', required: true, max_length: 120 }),
        row({ type: 4, custom_id: 'date', style: 1, label: 'Date (YYYY-MM-DD)', required: true, placeholder: '2026-10-01' }),
        row({ type: 4, custom_id: 'times', style: 1, label: 'Time, Helsinki (start-end)', required: true, placeholder: '18:00-22:00' }),
        row({ type: 4, custom_id: 'team_size', style: 1, label: 'Team size (empty = individual signups)', required: false, placeholder: '2' }),
        row({ type: 4, custom_id: 'capacity', style: 1, label: 'Capacity (people, or teams)', required: false, placeholder: 'unlimited' }),
      ],
    },
  };
}

async function participantNames(env: WorkerEnv, eventId: number): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const signup of await listSignups(env.DB, eventId)) {
    names.set(`u:${signup.discord_id}`, signup.username);
  }
  for (const team of await listEventTeams(env.DB, eventId)) {
    names.set(`t:${team.id}`, team.name);
  }
  return names;
}

async function handleComponent(env: WorkerEnv, interaction: Interaction, origin: string): Promise<void> {
  const edit = (content: string, components: unknown[] = []) =>
    editInteractionReply(interaction.application_id, interaction.token, content, components);
  const customId = interaction.data!.custom_id!;
  const now = Math.floor(Date.now() / 1000);

  try {
    if (customId.startsWith('t:pick:')) {
      // Step 2: choose which event the action applies to.
      const action = customId.slice('t:pick:'.length);
      const events = await listUpcomingEvents(env.DB, now);
      if (events.length === 0) {
        await edit('No upcoming events to act on.');
        return;
      }
      await edit(`Pick the event to **${action === 'winner' ? 'record a winner for' : action}**:`, [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `t:do:${action}`,
              options: events.slice(0, 25).map((event) => ({
                label: event.title.slice(0, 100),
                description: formatHelsinki(event.starts_at).slice(0, 100),
                value: String(event.id),
              })),
            },
          ],
        },
      ]);
    } else if (customId.startsWith('t:do:')) {
      const action = customId.slice('t:do:'.length);
      const eventId = Number(interaction.data!.values?.[0]);
      if (action === 'close' || action === 'reopen') {
        await setSignupsClosed(env.DB, eventId, action === 'close', now);
        await edit(action === 'close' ? `Signups closed for event #${eventId}.` : `Signups reopened for event #${eventId}.`);
      } else if (action === 'bracket') {
        await generateBracket(env.DB, eventId);
        await edit(`Bracket generated: ${origin}/events/${eventId}/bracket`);
      } else if (action === 'winner') {
        // Step 3: every ready, undecided match offers both possible winners.
        const names = await participantNames(env, eventId);
        const nameOf = (key: string) => names.get(key) ?? 'Unknown';
        const options = (await getBracket(env.DB, eventId))
          .filter((m) => m.winner === null && m.side_a !== null && m.side_b !== null)
          .flatMap((m) =>
            [m.side_a!, m.side_b!].map((key, i) => ({
              label: `${nameOf(key)} wins`.slice(0, 100),
              description: `R${m.round}: vs ${nameOf(i === 0 ? m.side_b! : m.side_a!)}`.slice(0, 100),
              value: `${m.round}:${m.slot}:${key}`,
            })),
          )
          .slice(0, 25);
        if (options.length === 0) {
          await edit(`No undecided matches on event #${eventId}. ${origin}/events/${eventId}/bracket`);
          return;
        }
        await edit('Who won their match?', [
          { type: 1, components: [{ type: 3, custom_id: `t:win:${eventId}`, options }] },
        ]);
      }
    } else if (customId.startsWith('t:win:')) {
      const eventId = Number(customId.slice('t:win:'.length));
      const [round, slot, ...keyParts] = String(interaction.data!.values?.[0]).split(':');
      const key = keyParts.join(':');
      await setBracketWinner(env.DB, eventId, Number(round), Number(slot), key);
      const names = await participantNames(env, eventId);
      await edit(
        `Recorded: **${names.get(key) ?? key}** wins round ${round}. ${origin}/events/${eventId}/bracket`,
      );
    } else {
      await edit('Unknown control.');
    }
  } catch (error) {
    await edit(error instanceof RuleError ? error.message : 'Something went wrong.');
  }
}

async function handleCreateModal(env: WorkerEnv, interaction: Interaction, origin: string): Promise<void> {
  const reply = (content: string) =>
    editInteractionReply(interaction.application_id, interaction.token, content);
  try {
    const fields = new Map<string, string>();
    for (const modalRow of interaction.data!.components ?? []) {
      for (const component of modalRow.components) {
        fields.set(component.custom_id, component.value ?? '');
      }
    }
    const date = fields.get('date') ?? '';
    const [startText, endText] = (fields.get('times') ?? '')
      .split(/\s*(?:-|–|—|to)\s*/i)
      .map((part) => part.trim());
    const startsAt = helsinkiToUnix(date, startText ?? '');
    if (startsAt === null) {
      await reply('Date or time did not parse. Use `YYYY-MM-DD` and `18:00-22:00` (Helsinki).');
      return;
    }
    let endsAt: number | null = null;
    if (endText) {
      endsAt = helsinkiToUnix(date, endText);
      if (endsAt !== null && endsAt <= startsAt) endsAt += 86400;
    }
    const teamSizeText = (fields.get('team_size') ?? '').trim();
    const capacityText = (fields.get('capacity') ?? '').trim();
    const invoker = interaction.member!.user!;
    const now = Math.floor(Date.now() / 1000);
    await upsertMember(
      env.DB,
      {
        discord_id: invoker.id,
        username: interaction.member?.nick ?? invoker.global_name ?? invoker.username,
        avatar_hash: invoker.avatar,
      },
      now,
    );
    const title = fields.get('title') ?? '';
    const teamSize = teamSizeText ? Number(teamSizeText) : null;
    const id = await createEvent(
      env.DB,
      {
        title,
        description: null,
        starts_at: startsAt,
        ends_at: endsAt,
        capacity: capacityText ? Number(capacityText) : null,
        team_size: teamSize,
        created_by: invoker.id,
      },
      now,
    );
    if (env.DISCORD_WEBHOOK_URL) {
      const messageId = await postWebhook(
        env.DISCORD_WEBHOOK_URL,
        eventAnnouncement({ title, startsAt, endsAt, organizers: null, teamSize, url: `${origin}/events/${id}` }),
      );
      if (messageId) await setEventMessageId(env.DB, id, messageId);
    }
    await reply(`Created event #${id}: **${title.trim()}**\n${origin}/events/${id}`);
  } catch (error) {
    await reply(error instanceof RuleError ? error.message : 'Something went wrong.');
  }
}

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
      let endsAt: number | null = null;
      if (opts.has('end_time')) {
        endsAt = helsinkiToUnix(String(opts.get('date') ?? ''), String(opts.get('end_time')));
        if (endsAt !== null && endsAt <= startsAt) endsAt += 86400;
      }
      const capacity = opts.has('capacity') ? Number(opts.get('capacity')) : null;
      const teamSize = opts.has('team_size') ? Number(opts.get('team_size')) : null;
      const organizers = opts.has('organizers') ? String(opts.get('organizers')) : null;
      const linkUrl = opts.has('link') ? String(opts.get('link')) : null;
      const title = String(opts.get('name') ?? '');
      const id = await createEvent(
        env.DB,
        {
          title,
          description: null,
          starts_at: startsAt,
          ends_at: endsAt,
          capacity,
          team_size: teamSize,
          organizers,
          link_url: linkUrl,
          created_by: invoker.id,
        },
        now,
      );
      if (env.DISCORD_WEBHOOK_URL) {
        const messageId = await postWebhook(
          env.DISCORD_WEBHOOK_URL,
          eventAnnouncement({
            title,
            startsAt,
            endsAt,
            organizers,
            teamSize,
            url: `${origin}/events/${id}`,
          }),
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
    } else if (name === 'event close' || name === 'event reopen') {
      const id = Number(opts.get('id'));
      const closing = name === 'event close';
      await setSignupsClosed(env.DB, id, closing, now);
      await reply(closing ? `Signups closed for event #${id}.` : `Signups reopened for event #${id}.`);
    } else if (name === 'bracket generate') {
      const id = Number(opts.get('event'));
      await generateBracket(env.DB, id);
      await reply(`Bracket generated: ${origin}/events/${id}/bracket`);
    } else if (name === 'bracket win') {
      const id = Number(opts.get('event'));
      const who = String(opts.get('name') ?? '').trim().toLowerCase();
      // Resolve the participant by team name or member name, then decide
      // their lowest undecided match.
      let key: string | null = null;
      for (const team of await listEventTeams(env.DB, id)) {
        if (team.name.toLowerCase() === who) key = `t:${team.id}`;
      }
      if (!key) {
        for (const signup of await listSignups(env.DB, id)) {
          if (signup.username.toLowerCase() === who) key = `u:${signup.discord_id}`;
        }
      }
      if (!key) {
        await reply(`No team or player called "${opts.get('name')}" on event #${id}.`);
        return;
      }
      const match = (await getBracket(env.DB, id))
        .filter((m) => m.winner === null && m.side_a !== null && m.side_b !== null)
        .filter((m) => m.side_a === key || m.side_b === key)
        .sort((a, b) => a.round - b.round)[0];
      if (!match) {
        await reply(`No undecided match for "${opts.get('name')}" right now.`);
        return;
      }
      await setBracketWinner(env.DB, id, match.round, match.slot, key);
      await reply(`Recorded: **${opts.get('name')}** wins round ${match.round}. ${origin}/events/${id}/bracket`);
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
