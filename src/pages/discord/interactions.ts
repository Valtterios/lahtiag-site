import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  editInteractionReply,
  editInteractionReplyWithFile,
  fetchGuildMemberRoles,
  hasAdminRole,
  postWebhook,
  verifyInteractionSignature,
} from '../../lib/discord';
import {
  cancelEvent,
  createAnnouncement,
  createEvent,
  generateBracket,
  addBracket,
  createBracket,
  listBrackets,
  goLiveBracket,
  getBracket,
  listEventTeams,
  listSignups,
  listUpcomingEvents,
  listPastEvents,
  setAnnouncementMessageId,
  setBracketWinner,
  clearBracketWinner,
  setDisplayNote,
  setEventMessageId,
  setSignupsClosed,
  upsertMember,
  RuleError,
  getRegisterByDiscord,
  toggleInterest,
  joinWaitlist,
  getEvent,
  setSignup,
  listEventQuestions,
  listResults,
  type RegisterRow,
} from '../../lib/db';
import { formatHelsinki, formatHelsinkiDate, helsinkiToUnix } from '../../lib/time';
import { syncScheduledEvent, setUpEventDiscord } from '../../lib/event-discord';
import { participantNames, postSignups, postBracketOut, postResult, postRevert, postEventLine, cancelLine, screenLine, dropLiveBracket } from '../../lib/event-channel';
import { cardFace, memberCardPng } from '../../lib/member-card';
import { cleanText } from '../../lib/raster';
import { postEventAnnouncement, refreshEventAnnouncement } from '../../lib/announce';
import { syncEventRolesInBackground } from '../../lib/event-discord';
import { announcePromotions } from '../../lib/event-channel';
import { MEMBER_TYPE_LABELS } from '../../lib/register';
import { DISCORD_GUILD_ID } from '../../lib/config';
import {
  setOwnMinecraftName,
  addMinecraftFriend,
  removeMinecraftName,
  listMinecraftNames,
  addBoardMinecraftName,
  dropMinecraftName,
  listPendingFriends,
  approveMinecraftName,
  declineMinecraftName,
  friendRequestLine,
  linkBoardName,
  faceUrl,
  serversLabel,
  narrowed,
  FRIENDS_PER_MEMBER,
} from '../../lib/minecraft';
import { postBoardLine, approveButtons, decidedLine } from '../../lib/board-channel';
import { setActive as setRegisterActive, isLeaderboardOptIn } from '../../lib/db';
import { applyRoles as applyRegisterRoles, loadRoleConfig as loadRegisterRoleConfig } from '../../lib/roles';
import { editChannelMessage as editBoardMessage, dmUser as dmMember, SUPPRESS_EMBEDS as NO_EMBEDS, dismissReply } from '../../lib/discord';
import { seasonSummary, seasonLines } from '../../lib/season';
import { passCardPng, homePage, pageCount, clampPage } from '../../lib/pass-card';
import { passLines } from '../../lib/pass';
import { listClaimableKinds, createClaim, decideClaim, claimLine, claimDecisionDm, CLAIM_NOTE_MAX } from '../../lib/claims';
import { getTickKind, kindWorth } from '../../lib/ticks';
import { xpStandings, leaderboardEmbed } from '../../lib/xp';
import { NO_MENTIONS } from '../../lib/discord';

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

// What a deferred handler leaves behind: nothing (its reply clears itself
// after a while) or 'keep' for a panel, a listing, or a link the person
// still needs.
type Outcome = 'keep' | undefined;

interface Interaction {
  type: number;
  application_id: string;
  channel_id?: string;
  message?: { id: string; content?: string }; // the message a button sits on
  token: string;
  guild_id?: string;
  data?: {
    name?: string;
    options?: Option[];
    custom_id?: string;
    values?: string[];
    components?: ModalRow[];
    resolved?: {
      users?: Record<string, { id: string; username: string; global_name: string | null; avatar: string | null }>;
      // Discord resolves the picked member too, roles and all, so the card
      // can say who is on the board without asking Discord again.
      members?: Record<string, { roles?: string[]; nick?: string | null }>;
    };
  };
  member?: { roles?: string[]; nick?: string | null; user?: { id: string; username: string; global_name: string | null; avatar: string | null } };
}

// Link buttons (style 5) open a page; that is where signing in happens.
function membershipButtons(entry: RegisterRow | null, origin: string): unknown[] {
  const link = (label: string, url: string) => ({ type: 2, style: 5, label, url });
  const row = (...components: unknown[]) => ({ type: 1, components });
  if (!entry) {
    return [row(link('Apply for membership', `${origin}/join`), link('Already a member? Link my account', `${origin}/login?next=/join`))];
  }
  return [row(link('My membership', `${origin}/membership`), link('Events', `${origin}/events`))];
}

function membershipStatus(entry: RegisterRow | null, origin: string): string {
  if (!entry) {
    return "This Discord account isn't linked to a LahtiAG membership yet. Membership is free for higher education students in Lahti. New here? Apply. Joined through the old form? Sign in on the site and link this account.";
  }
  if (entry.status === 'pending') {
    return `Your membership application from ${formatHelsinkiDate(entry.applied_at)} is waiting for the board.`;
  }
  if (entry.status === 'former') return `You're listed as a former member. Email board@lahtiag.fi to rejoin.`;
  const since = formatHelsinkiDate(entry.decided_at ?? entry.applied_at);
  const active = entry.is_active
    ? " You're an active."
    : entry.wants_active
      ? ' Your actives request is waiting for the board.'
      : '';
  return `${MEMBER_TYPE_LABELS[entry.member_type]} of LahtiAG since ${since}.${active} Manage it at ${origin}/membership`;
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
  // A valid signature is replayable forever without a freshness bound.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return new Response('Stale timestamp.', { status: 401 });
  }

  const interaction = JSON.parse(body) as Interaction;

  if (interaction.type === 1) return json({ type: 1 }); // PING -> PONG

  // Errors and confirmations clear themselves, the way a notification
  // would (dismissReply); a handler answers 'keep' for what must stay.
  // Immediate refusals get the same treatment.
  const arrivedAt = Date.now();
  const dismiss = () => dismissReply(interaction.application_id, interaction.token, arrivedAt);
  const fleeting = async (work: Promise<Outcome | void>): Promise<void> => {
    let outcome: Outcome | void;
    try {
      outcome = await work;
    } catch (error) {
      await dismiss();
      throw error;
    }
    if (outcome !== 'keep') await dismiss();
  };
  const refuse = (content: string) => {
    locals.cfContext.waitUntil(dismiss());
    return json({ type: 4, data: { content, flags: 64 } });
  };

  // Only the LahtiAG guild: an interaction Discord signed but that arrives
  // from any other server (or a DM) is refused before any role check.
  if (interaction.guild_id !== DISCORD_GUILD_ID) {
    return refuse('This app only works inside the LahtiAG server.');
  }

  const isAdmin = hasAdminRole(interaction.member?.roles ?? [], env.ADMIN_ROLE_ID);

  // /membership and /join: anyone in the server asks about themselves;
  // one D1 read, answered directly and only to them, with link buttons to
  // the page that does the rest (a bot can't sign anyone in).
  if (interaction.type === 2 && (interaction.data?.name === 'membership' || interaction.data?.name === 'join')) {
    const userId = interaction.member?.user?.id;
    const entry = userId ? await getRegisterByDiscord(env.DB, userId) : null;
    return json({
      type: 4,
      data: { content: membershipStatus(entry, url.origin), flags: 64, components: membershipButtons(entry, url.origin) },
    });
  }

  // Fun and info commands: public answers, no role needed.
  if (interaction.type === 2 && interaction.data?.name && FUN_COMMANDS.has(interaction.data.name)) {
    locals.cfContext.waitUntil(fleeting(handleFun(env, interaction, url.origin)));
    return json({ type: 5 });
  }

  // /season: the person's own season so far, privately, with where they
  // stand on the pass. A listing, so it stays.
  if (interaction.type === 2 && interaction.data?.name === 'season') {
    locals.cfContext.waitUntil(fleeting(handleSeason(env, interaction, url.origin)));
    return json({ type: 5, data: { flags: 64 } });
  }
  // /pass: the pass as a picture, privately, paged by its buttons.
  if (interaction.type === 2 && interaction.data?.name === 'pass') {
    locals.cfContext.waitUntil(fleeting(handlePassCard(env, interaction, url.origin, null)));
    return json({ type: 5, data: { flags: 64 } });
  }

  // /claim: ask the board for a tick, privately, step by step (the panel
  // stays). /leaderboard: this season's XP, for everyone, with buttons
  // that answer privately to whoever presses them.
  if (interaction.type === 2 && interaction.data?.name === 'claim') {
    locals.cfContext.waitUntil(fleeting(handleClaimStart(env, interaction)));
    return json({ type: 5, data: { flags: 64 } });
  }
  if (interaction.type === 2 && interaction.data?.name === 'leaderboard') {
    locals.cfContext.waitUntil(fleeting(handleLeaderboard(env, interaction, url.origin)));
    return json({ type: 5 });
  }

  // /whitelist: the Minecraft server's list. Private answers; the board
  // subcommands check the role themselves.
  if (interaction.type === 2 && interaction.data?.name === 'whitelist') {
    locals.cfContext.waitUntil(fleeting(handleWhitelist(env, interaction, url.origin, isAdmin)));
    return json({ type: 5, data: { flags: 64 } });
  }

  // /profile: anyone's stats card, for everyone to see. Deferred without
  // the ephemeral flag, then the picture is attached.
  if (interaction.type === 2 && interaction.data?.name === 'profile') {
    locals.cfContext.waitUntil(fleeting(handleProfile(env, interaction, url.origin)));
    return json({ type: 5 });
  }

  // /board renders the interactive control panel: no database work, so
  // it responds directly instead of deferring.
  if (interaction.type === 2 && interaction.data?.name === 'board') {
    if (!isAdmin) {
      return refuse('This needs the admin role.');
    }
    return json({ type: 4, data: { flags: 64, ...controlPanel(url.origin) } });
  }

  // The card's Turn over (p:b:..., p:f:...): anyone looking at it. The
  // message it sits on is edited in place, so the answer is a deferred
  // update rather than a reply of its own.
  if (interaction.type === 3 && /^p:[bf]:/.test(interaction.data?.custom_id ?? '')) {
    locals.cfContext.waitUntil(fleeting(handleProfileTurn(env, interaction, interaction.data!.custom_id!, url.origin)));
    return json({ type: 6 });
  }

  // Announcement buttons (e:go, e:maybe, e:heart): anyone in the server.
  // Deferred privately, then the answer is only theirs to see.
  if (interaction.type === 3 && interaction.data?.custom_id?.startsWith('e:')) {
    locals.cfContext.waitUntil(fleeting(handleEventButton(env, interaction, url.origin, locals.cfContext)));
    return json({ type: 5, data: { flags: 64 } });
  }

  // Season buttons (s:...): anyone in the server, answered privately even
  // when the button sits on the public leaderboard. A modal must be the
  // immediate response; a pick inside the private claim panel edits the
  // panel; the rest is a fresh private reply.
  if (interaction.type === 3 && interaction.data?.custom_id?.startsWith('s:')) {
    const id = interaction.data.custom_id;
    if (id === 's:mc') return json(minecraftNameModal());
    if (id.startsWith('s:claimev:')) return json(claimNoteModal(id.slice('s:claimev:'.length), String(interaction.data.values?.[0] ?? '0')));
    if (id === 's:claimkind') {
      locals.cfContext.waitUntil(fleeting(handleClaimEventPick(env, interaction)));
      return json({ type: 6 });
    }
    // A page of the pass picture: swapped into the message that is there.
    if (id.startsWith('s:pass:')) {
      locals.cfContext.waitUntil(fleeting(handlePassCard(env, interaction, url.origin, Number(id.slice('s:pass:'.length)))));
      return json({ type: 6 });
    }
    locals.cfContext.waitUntil(fleeting(handleSeasonButton(env, interaction, url.origin)));
    return json({ type: 5, data: { flags: 64 } });
  }
  if (interaction.type === 5 && interaction.data?.custom_id?.startsWith('s:modal:')) {
    locals.cfContext.waitUntil(fleeting(handleSeasonModal(env, interaction, url.origin)));
    return json({ type: 5, data: { flags: 64 } });
  }

  // Approve / Decline under a board line (a whitelist friend, an actives
  // request, a tick claim): any board member. The line itself is
  // rewritten, no reply.
  if (interaction.type === 3 && interaction.data?.custom_id && /^[wac]:(ok|no):/.test(interaction.data.custom_id)) {
    if (!isAdmin) {
      return refuse('This needs the admin role.');
    }
    locals.cfContext.waitUntil(handleBoardButton(env, interaction, url.origin));
    return json({ type: 6 });
  }

  // Button and select-menu clicks (type 3). Opening a modal must be the
  // immediate response; everything else acks (type 6) and edits the panel
  // message once the work is done.
  if (interaction.type === 3 && interaction.data?.custom_id) {
    if (!isAdmin) {
      return refuse('This needs the admin role.');
    }
    if (interaction.data.custom_id === 't:create') {
      return json(createEventModal());
    }
    if (interaction.data.custom_id === 't:announce') {
      return json(announceModal());
    }
    if (interaction.data.custom_id === 't:do:screen') {
      return json(screenModal(String(interaction.data.values?.[0])));
    }
    locals.cfContext.waitUntil(fleeting(handleComponent(env, interaction, url.origin)));
    return json({ type: 6 });
  }

  // Modal submits (type 5): defer, create, then edit the reply.
  if (interaction.type === 5 && interaction.data?.custom_id?.startsWith('t:modal:')) {
    if (!isAdmin) {
      return refuse('This needs the admin role.');
    }
    const modalId = interaction.data.custom_id;
    locals.cfContext.waitUntil(
      fleeting(
        modalId === 't:modal:create'
          ? handleCreateModal(env, interaction, url.origin)
          : modalId.startsWith('t:modal:screen:')
            ? handleScreenModal(env, interaction)
            : handleAnnounceModal(env, interaction, url.origin),
      ),
    );
    return json({ type: 5, data: { flags: 64 } });
  }

  if (interaction.type !== 2 || !interaction.data) {
    return refuse('Unsupported interaction.');
  }

  // Acknowledge inside Discord's 3-second budget, do the database work in
  // the background, then edit the reply (spec: otherwise "The application
  // did not respond" even when the write succeeded).
  locals.cfContext.waitUntil(fleeting(handleCommand(env, interaction, url.origin)));
  return json({ type: 5, data: { flags: 64 } }); // deferred, ephemeral
};

// --- the Minecraft whitelist ---------------------------------------------------------

const WHITELIST_ERRORS: Record<string, string> = {
  bad_name: 'A Minecraft name is 3 to 16 letters, digits or underscores.',
  name_taken: 'That name is already on the list.',
  not_member: 'The whitelist needs a current membership. `/join` gets you one, or links your account.',
  missing: 'That is not a board name on the list.',
  has_name: 'That member has an own name already; take it off first.',
  friend_limit: `${FRIENDS_PER_MEMBER} friends per member. Take one off first with \`/whitelist remove\`.`,
  no_account: 'No Minecraft account has that name. Check the spelling (Java edition name).',
  mojang_down: "Mojang didn't answer. Try again in a minute.",
};

// The skin's face beside the answer, so people see it's their account.
function faceEmbed(origin: string, name: string, uuid: string, note: string): unknown[] {
  return [{ title: name, description: note, thumbnail: { url: faceUrl(origin, uuid) }, color: 0x2b5cff }];
}

// --- the season pass: /season, /claim, /leaderboard and the buttons under them ---

const CLAIM_ERRORS: Record<string, string> = {
  not_member: 'Claims need a current membership with your Discord account linked to it. `/join` sorts that out.',
  missing: 'That tick is not open for claims any more.',
  duplicate: 'You already have that: a tick for this event, or a claim waiting for the board.',
};

// The buttons under /season and the leaderboard: private follow-ups for
// whoever presses them, wherever the message sits.
function seasonButtons(origin: string, claimable: boolean, withSeason: boolean): unknown[] {
  return [
    {
      type: 1,
      components: [
        ...(withSeason ? [{ type: 2, style: 1, label: 'My season', custom_id: 's:me', emoji: { name: '📅' } }] : []),
        ...(claimable ? [{ type: 2, style: withSeason ? 2 : 1, label: 'Claim a tick', custom_id: 's:claim', emoji: { name: '🙋' } }] : []),
        { type: 2, style: 2, label: 'Link my Minecraft name', custom_id: 's:mc', emoji: { name: '⛏️' } },
        { type: 2, style: 5, label: 'Membership page', url: `${origin}/membership` },
      ],
    },
  ];
}

async function handleSeason(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
  const userId = interaction.member?.user?.id;
  if (!userId) return;
  const now = Math.floor(Date.now() / 1000);
  await rememberInvoker(env, interaction, now);
  const [summary, claimable] = await Promise.all([seasonSummary(env.DB, userId, now), listClaimableKinds(env.DB)]);
  await editInteractionReply(interaction.application_id, interaction.token, seasonLines(summary, origin), seasonButtons(origin, claimable.length > 0, false));
  return 'keep';
}

async function handleLeaderboard(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
  const now = Math.floor(Date.now() / 1000);
  await rememberInvoker(env, interaction, now);
  const [standings, claimable] = await Promise.all([xpStandings(env.DB, now), listClaimableKinds(env.DB)]);
  await editInteractionReply(
    interaction.application_id,
    interaction.token,
    '',
    seasonButtons(origin, claimable.length > 0, true),
    [leaderboardEmbed(standings, interaction.member?.user?.id ?? null, now)],
    NO_MENTIONS,
  );
  return 'keep';
}

// The table prints cached Discord names, so anyone who uses the season
// commands gets theirs cached, like the event buttons do.
async function rememberInvoker(env: WorkerEnv, interaction: Interaction, now: number): Promise<void> {
  const user = interaction.member?.user;
  if (!user) return;
  await upsertMember(env.DB, { discord_id: user.id, username: interaction.member?.nick ?? user.global_name ?? user.username, avatar_hash: user.avatar }, now);
}

// /pass, and its page buttons: the picture with the season's rungs, one
// page of them at a time, the reader's own name on it. A page number
// swaps the picture in place; without one the picture opens on the page
// with the next rung to reach.
async function handlePassCard(env: WorkerEnv, interaction: Interaction, origin: string, page: number | null): Promise<Outcome> {
  const userId = interaction.member?.user?.id;
  if (!userId) return;
  const now = Math.floor(Date.now() / 1000);
  await rememberInvoker(env, interaction, now);
  const season = await seasonSummary(env.DB, userId, now);
  const pages = pageCount(season.pass.levels.length);
  const p = clampPage(page ?? homePage(season.pass), season.pass.levels.length);
  const name = interaction.member?.nick ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? 'Member';
  const png = await passCardPng({ name, season: season.label, progress: season.pass, held: season.held }, p);
  const ok = await editInteractionReplyWithFile(
    interaction.application_id,
    interaction.token,
    passLines(season.pass, origin)[0],
    { name: `pass-${p}.png`, bytes: png, type: 'image/png' },
    passButtons(p, pages, origin),
  );
  if (!ok) await editInteractionReply(interaction.application_id, interaction.token, 'The pass could not be drawn. Try again in a moment.');
  return 'keep';
}

function passButtons(page: number, pages: number, origin: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        ...(pages > 1
          ? [
              { type: 2, style: 2, label: 'Previous', custom_id: `s:pass:${page - 1}`, disabled: page <= 1 },
              { type: 2, style: 2, label: `Page ${page} / ${pages}`, custom_id: 's:pass:0', disabled: true },
              { type: 2, style: 2, label: 'Next', custom_id: `s:pass:${page + 1}`, disabled: page >= pages },
            ]
          : []),
        { type: 2, style: 1, label: 'My season', custom_id: 's:me', emoji: { name: '📅' } },
        { type: 2, style: 5, label: 'Membership page', url: `${origin}/membership#pass` },
      ],
    },
  ];
}

// A button pressed under /season or the leaderboard: a fresh private reply.
async function handleSeasonButton(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
  const id = interaction.data?.custom_id ?? '';
  if (id === 's:me') return handleSeason(env, interaction, origin);
  if (id === 's:claim') return handleClaimStart(env, interaction);
  await editInteractionReply(interaction.application_id, interaction.token, 'Unknown button.');
}

// /claim, step 1: which tick. The panel is private and stays; the picks
// swap it in place until the note's modal opens.
async function handleClaimStart(env: WorkerEnv, interaction: Interaction): Promise<Outcome> {
  const reply = (content: string, components: unknown[] = []) => editInteractionReply(interaction.application_id, interaction.token, content, components);
  const userId = interaction.member?.user?.id;
  if (!userId) return;
  const kinds = await listClaimableKinds(env.DB);
  if (kinds.length === 0) {
    await reply('Nothing is open for claims right now; the board gives ticks by hand.');
    return;
  }
  const entry = await getRegisterByDiscord(env.DB, userId);
  if (!entry || entry.status !== 'member') {
    await reply(CLAIM_ERRORS.not_member);
    return;
  }
  await reply('🙋 **Claim a tick** for the season pass · step 1 of 3. Which tick?', [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: 's:claimkind',
          placeholder: 'Pick a tick',
          options: kinds.slice(0, 25).map((k) => ({
            label: k.name.slice(0, 100),
            description: `${kindWorth(k)}${k.description ? ` · ${k.description}` : ''}`.slice(0, 100),
            value: String(k.id),
          })),
        },
      ],
    },
  ]);
  return 'keep';
}

// Step 2: which event, if any; the same panel, edited in place. The past
// comes first, newest on top, since that is where the helping happened.
async function handleClaimEventPick(env: WorkerEnv, interaction: Interaction): Promise<Outcome> {
  const edit = (content: string, components: unknown[] = []) => editInteractionReply(interaction.application_id, interaction.token, content, components);
  const kind = await getTickKind(env.DB, Number(interaction.data?.values?.[0]));
  if (!kind || !kind.claimable || kind.retired_at !== null) {
    await edit(CLAIM_ERRORS.missing);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const [past, upcoming] = await Promise.all([listPastEvents(env.DB, now, 12), listUpcomingEvents(env.DB, now)]);
  const events = [...past, ...upcoming].slice(0, 24);
  await edit(`🙋 **Claim a tick** · step 2 of 3: **${kind.name}** (${kindWorth(kind)}). For which event? Pick one, or no particular event; a short form then asks what you did.`, [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `s:claimev:${kind.id}`,
          placeholder: 'Pick the event, or none',
          options: [
            { label: 'No particular event', value: '0' },
            ...events.map((e) => ({ label: e.title.slice(0, 100), description: formatHelsinkiDate(e.starts_at), value: String(e.id) })),
          ],
        },
      ],
    },
  ]);
  return 'keep';
}

// Step 3: what they did, in a modal (the immediate answer to the event pick).
function claimNoteModal(kindId: string, eventId: string) {
  const field = (component: Record<string, unknown>) => ({ type: 1, components: [component] });
  return {
    type: 9,
    data: {
      custom_id: `s:modal:claim:${kindId}:${eventId}`,
      title: 'Claim a tick · step 3 of 3',
      components: [field({ type: 4, custom_id: 'note', style: 2, label: 'What did you do?', required: true, max_length: CLAIM_NOTE_MAX, placeholder: 'Set up the screens and ran the desk' })],
    },
  };
}

// "Link my Minecraft name": the same as /whitelist me, from a button.
function minecraftNameModal() {
  const field = (component: Record<string, unknown>) => ({ type: 1, components: [component] });
  return {
    type: 9,
    data: {
      custom_id: 's:modal:mc',
      title: 'Link your Minecraft name',
      components: [field({ type: 4, custom_id: 'name', style: 1, label: 'Your Minecraft (Java) name', required: true, min_length: 3, max_length: 16, placeholder: 'Steve' })],
    },
  };
}

async function handleSeasonModal(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
  const reply = (content: string, embeds: unknown[] = []) => editInteractionReply(interaction.application_id, interaction.token, content, [], embeds);
  const userId = interaction.member?.user?.id;
  if (!userId) return;
  const fields = new Map<string, string>();
  for (const modalRow of interaction.data?.components ?? []) {
    for (const component of modalRow.components) fields.set(component.custom_id, component.value ?? '');
  }
  const now = Math.floor(Date.now() / 1000);
  const modalId = interaction.data?.custom_id ?? '';
  const page = `${origin}/membership#minecraft`;
  try {
    if (modalId === 's:modal:mc') {
      const p = await setOwnMinecraftName(env.DB, userId, fields.get('name') ?? '', now);
      if (p.takenFrom && env.DISCORD_BOT_TOKEN) {
        await dmMember(env.DISCORD_BOT_TOKEN, p.takenFrom, `**${p.name}** is a member now and took their whitelist name with them. Your friend slot is free again: ${page}`);
      }
      await reply(`✅ **${p.name}** is on the whitelist as you, on every server. The server picks it up within a few minutes.`, faceEmbed(origin, p.name, p.uuid, 'Your skin? Then it is the right account.'));
      return;
    }
    if (modalId.startsWith('s:modal:claim:')) {
      const [kindText, eventText] = modalId.slice('s:modal:claim:'.length).split(':');
      const claim = await createClaim(env.DB, { discordId: userId, kindId: Number(kindText), eventId: Number(eventText) || null, note: fields.get('note') }, now);
      await postBoardLine(env.DB, env, claimLine(claim, origin), approveButtons('c', String(claim.id)));
      await reply(`📨 Your claim for **${claim.kind}**${claim.event ? ` (${claim.event})` : ''} went to the board. You get a DM once it is decided.`);
      return;
    }
    await reply('Unknown form.');
  } catch (error) {
    if (error instanceof RuleError) {
      const texts = modalId === 's:modal:mc' ? WHITELIST_ERRORS : CLAIM_ERRORS;
      await reply(texts[error.code] ?? error.message);
      return;
    }
    throw error;
  }
}

async function handleWhitelist(env: WorkerEnv, interaction: Interaction, origin: string, isAdmin: boolean): Promise<Outcome> {
  const reply = (content: string, embeds: unknown[] = []) => editInteractionReply(interaction.application_id, interaction.token, content, [], embeds);
  const sub = interaction.data?.options?.[0];
  const userId = interaction.member?.user?.id;
  if (!sub || !userId) {
    await reply('Something is missing from that command.');
    return;
  }
  const opts = optionMap(sub.options);
  const raw = String(opts.get('name') ?? '');
  const servers = String(opts.get('server') ?? 'all');
  const where = servers === 'all' ? 'every server' : `${serversLabel(servers)} only`;
  const shown = raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'that';
  const now = Math.floor(Date.now() / 1000);
  const soon = 'The server picks it up within a few minutes.';
  const page = `${origin}/membership#minecraft`;
  try {
    if (sub.name === 'me') {
      const p = await setOwnMinecraftName(env.DB, userId, raw, now);
      if (p.takenFrom && env.DISCORD_BOT_TOKEN) {
        await dmMember(env.DISCORD_BOT_TOKEN, p.takenFrom, `**${p.name}** is a member now and took their whitelist name with them. Your friend slot is free again: ${page}`);
      }
      await reply(`✅ **${p.name}** is on the whitelist as you, on every server. ${soon}`, faceEmbed(origin, p.name, p.uuid, 'Your skin? Then it is the right account.'));
    } else if (sub.name === 'friend') {
      const p = await addMinecraftFriend(env.DB, userId, raw, now, undefined, servers);
      if (p.approved) {
        await reply(`✅ **${p.name}** was on the list already, so it is your friend now, for ${where}. ${soon}`, faceEmbed(origin, p.name, p.uuid, "Your friend's skin? Then it is the right account."));
        return;
      }
      const who = interaction.member?.nick ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? 'A member';
      await postBoardLine(env.DB, env, friendRequestLine(who, p.name, servers === 'all' ? '' : servers, origin), approveButtons('w', p.name));
      await reply(`📨 Asked the board to whitelist **${p.name}** as your friend, for ${where}. You get a DM once a board member approves.`, faceEmbed(origin, p.name, p.uuid, "Your friend's skin? Then it is the right account."));
    } else if (sub.name === 'remove') {
      const gone = await removeMinecraftName(env.DB, userId, raw);
      await reply(gone ? `Took **${shown}** off the list. The server drops it within a few minutes.` : `**${shown}** is not one of your names.`);
    } else if (sub.name === 'list') {
      const names = await listMinecraftNames(env.DB, userId);
      const own = names.find((n) => n.kind === 'own' && n.uuid);
      await reply(
        names.length > 0
          ? `${names.map((n) => `• **${n.name}** (${n.kind === 'own' ? 'you' : n.kind === 'friend' ? 'your friend' : 'board'}${narrowed(n.servers) ? `, ${serversLabel(n.servers)} only` : ''}${n.approved_at === null ? ', waiting for the board' : ''})`).join('\n')}\n${page}`
          : `No names yet. \`/whitelist me <name>\` puts yours on the list, members only. ${page}`,
        own ? faceEmbed(origin, own.name, own.uuid!, 'Your skin.') : [],
      );
      return 'keep';
    } else if (['add', 'drop', 'pending', 'approve', 'decline', 'link'].includes(sub.name)) {
      if (!isAdmin) {
        await reply('This needs the admin role.');
        return;
      }
      if (sub.name === 'add') {
        const p = await addBoardMinecraftName(env.DB, userId, raw, now, undefined, servers);
        await reply(`✅ **${p.name}** is on the whitelist for ${where}, added by the board. ${soon}`, faceEmbed(origin, p.name, p.uuid, 'The account behind that name.'));
      } else if (sub.name === 'link') {
        const memberId = String(opts.get('member') ?? '');
        const row = await linkBoardName(env.DB, raw, memberId, userId, now);
        if (env.DISCORD_BOT_TOKEN) await dmMember(env.DISCORD_BOT_TOKEN, memberId, `⛏️ The board linked the Minecraft name **${row.name}** to you: it is on the whitelist as yours, on every server, and follows your membership. ${page}`);
        await postBoardLine(env.DB, env, `⛏️ Whitelist: **${row.name}** linked to <@${memberId}> by ${interaction.member?.nick ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? 'the board'}.`);
        await reply(`✅ **${row.name}** is <@${memberId}>'s own name now, on every server. They got a DM.`, row.uuid ? faceEmbed(origin, row.name, row.uuid, 'The account behind that name.') : []);
      } else if (sub.name === 'drop') {
        const gone = await dropMinecraftName(env.DB, raw);
        await reply(gone ? `Dropped **${gone.name}** (${gone.kind === 'own' ? 'a member' : gone.kind === 'friend' ? "a member's friend" : 'board'}). The server removes it within a few minutes.` : `**${shown}** is not on the list.`);
      } else if (sub.name === 'pending') {
        const rows = await listPendingFriends(env.DB);
        await reply(
          rows.length > 0
            ? `${rows.map((r) => `• **${r.name}** for ${narrowed(r.servers) ? `${serversLabel(r.servers)} only` : 'every server'}, brought by ${r.by_name ?? r.discord_id}`).join('\n')}\n\`/whitelist approve <name>\` or ${origin}/whitelist`
            : `Nothing waiting. ${origin}/whitelist`,
        );
        return 'keep';
      } else if (sub.name === 'approve') {
        const row = await approveMinecraftName(env.DB, raw, userId, now);
        if (!row) {
          await reply(`**${shown}** is not waiting for a decision.`);
          return;
        }
        if (env.DISCORD_BOT_TOKEN) await dmMember(env.DISCORD_BOT_TOKEN, row.discord_id, `✅ Your friend **${row.name}** is on the whitelist now. The servers pick it up within a few minutes. ${page}`);
        const by = interaction.member?.nick ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? 'the board';
        await postBoardLine(env.DB, env, `✅ Whitelist: **${row.name}** (friend of ${row.by_name ?? row.discord_id}) approved by ${by}.`);
        await reply(`✅ **${row.name}** approved. ${soon}`);
      } else {
        const row = await declineMinecraftName(env.DB, raw);
        if (!row) {
          await reply(`**${shown}** is not waiting for a decision.`);
          return;
        }
        if (env.DISCORD_BOT_TOKEN) await dmMember(env.DISCORD_BOT_TOKEN, row.discord_id, `The board didn't approve **${row.name}** for the whitelist. Ask a board member if you want to know more.`);
        const by = interaction.member?.nick ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? 'the board';
        await postBoardLine(env.DB, env, `❌ Whitelist: **${row.name}** (friend of ${row.by_name ?? row.discord_id}) declined by ${by}.`);
        await reply(`❌ **${row.name}** declined; the member got a DM.`);
      }
    } else {
      await reply('Unknown subcommand.');
    }
  } catch (error) {
    if (error instanceof RuleError) {
      await reply(WHITELIST_ERRORS[error.code] ?? error.message);
      return;
    }
    throw error;
  }
}

// Approve / Decline pressed under a board line: a whitelist friend ("w",
// keyed by name) or an actives request ("a", keyed by register id). The
// line is rewritten with the outcome and loses its buttons.
async function handleBoardButton(env: WorkerEnv, interaction: Interaction, origin: string): Promise<void> {
  const [kind, verdict, key] = interaction.data!.custom_id!.split(':');
  const user = interaction.member?.user;
  const who = interaction.member?.nick ?? user?.global_name ?? user?.username ?? 'a board member';
  const token = env.DISCORD_BOT_TOKEN;
  const now = Math.floor(Date.now() / 1000);
  const original = interaction.message?.content ?? '';
  const settle = async (outcome: string) => {
    if (token && interaction.channel_id && interaction.message?.id) {
      await editBoardMessage(token, interaction.channel_id, interaction.message.id, decidedLine(original, outcome), NO_EMBEDS, []);
    }
  };
  try {
    if (kind === 'w') {
      if (verdict === 'ok') {
        const row = await approveMinecraftName(env.DB, key, user?.id ?? 'board', now);
        if (!row) {
          await settle('ℹ️ Already handled.');
          return;
        }
        if (token) await dmMember(token, row.discord_id, `✅ Your friend **${row.name}** is on the whitelist now. The servers pick it up within a few minutes. ${origin}/membership#minecraft`);
        await settle(`✅ Approved by ${who}.`);
      } else {
        const row = await declineMinecraftName(env.DB, key);
        if (!row) {
          await settle('ℹ️ Already handled.');
          return;
        }
        if (token) await dmMember(token, row.discord_id, `The board didn't approve **${row.name}** for the whitelist. Ask a board member if you want to know more.`);
        await settle(`❌ Declined by ${who}.`);
      }
    } else if (kind === 'a') {
      const entry = await setRegisterActive(env.DB, Number(key), verdict === 'ok', who, now);
      await applyRegisterRoles(await loadRegisterRoleConfig(env, env.DB), entry);
      await settle(verdict === 'ok' ? `✅ Approved by ${who}; the Actives role is on.` : `❌ Declined by ${who}.`);
    } else if (kind === 'c') {
      const result = await decideClaim(env.DB, Number(key), verdict === 'ok' ? 'approve' : 'decline', who, now);
      if (!result) {
        await settle('ℹ️ Already handled.');
        return;
      }
      if (token) await dmMember(token, result.claim.discord_id, claimDecisionDm(result.claim, origin));
      await settle(verdict === 'ok' ? `✅ Approved by ${who}; the tick is given.` : `❌ Declined by ${who}.`);
    }
  } catch (error) {
    if (error instanceof RuleError) {
      await settle(`⚠️ ${error.message}`);
      return;
    }
    throw error;
  }
}

// --- fun and info commands ----------------------------------------------------------

const FUN_COMMANDS = new Set(['roll', 'coin', 'pick', 'next', 'champion']);

export function rollDice(sides: number, count: number): number[] {
  const s = Math.min(1000, Math.max(2, Math.floor(sides) || 6));
  const n = Math.min(10, Math.max(1, Math.floor(count) || 1));
  const out: number[] = [];
  const random = new Uint32Array(n);
  crypto.getRandomValues(random);
  for (let i = 0; i < n; i++) out.push((random[i] % s) + 1);
  return out;
}

export function pickOne(text: string): string | null {
  const options = text.split(/[,;\n]|\s+or\s+/i).map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) return null;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return options[random[0] % options.length];
}

async function handleFun(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
  const reply = (content: string) => editInteractionReply(interaction.application_id, interaction.token, content);
  const name = interaction.data!.name!;
  const opts = optionMap(interaction.data!.options);
  const who = interaction.member?.nick ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? 'Someone';
  const clean = (s: string) => s.replace(/[`*_~|>\[\]()@#]/g, '').trim();
  if (name === 'roll') {
    const sides = Number(opts.get('sides') ?? 6);
    const count = Number(opts.get('count') ?? 1);
    const rolls = rollDice(sides, count);
    await reply(rolls.length === 1 ? `🎲 ${clean(who)} rolled **${rolls[0]}** (d${Math.min(1000, Math.max(2, Math.floor(sides) || 6))})` : `🎲 ${clean(who)} rolled ${rolls.join(', ')} (sum **${rolls.reduce((a, b) => a + b, 0)}**)`);
  } else if (name === 'coin') {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    await reply(`🪙 ${clean(who)} flipped… **${random[0] % 2 === 0 ? 'Heads' : 'Tails'}**!`);
  } else if (name === 'pick') {
    const picked = pickOne(String(opts.get('options') ?? ''));
    if (!picked) {
      await reply('Give me at least two options, separated by commas.');
      return;
    }
    await reply(`🎯 ${clean(who)} asked me to choose: **${clean(picked)}**`);
  } else if (name === 'next') {
    const events = (await listUpcomingEvents(env.DB, Math.floor(Date.now() / 1000), false)).slice(0, 3);
    if (events.length === 0) {
      await reply(`Nothing on the calendar yet. ${origin}/events`);
      return 'keep';
    }
    await reply(
      ['📅 **Coming up**', ...events.map((e) => `• ${formatHelsinki(e.starts_at)} · **${clean(e.title)}** · ${e.team_size !== null ? `${e.teams_count} teams` : `${e.yes_count} going`}${e.interest_count > 0 ? ` · ♡ ${e.interest_count}` : ''} · ${origin}/events/${e.id}`)].join('\n'),
    );
  } else if (name === 'champion') {
    const latest = (await listResults(env.DB, 1))[0];
    await reply(latest ? `🏆 Reigning champion: **${clean(latest.champion_name)}**, from **${clean(latest.title)}** (${formatHelsinki(latest.starts_at)}). ${origin}/history` : 'No tournament has been decided yet. Be the first!');
  }
  return 'keep';
}

// --- announcement buttons ------------------------------------------------------

async function handleEventButton(env: WorkerEnv, interaction: Interaction, origin: string, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
  const reply = (content: string) => editInteractionReply(interaction.application_id, interaction.token, content);
  const [, action, idText] = interaction.data!.custom_id!.split(':');
  const eventId = Number(idText);
  const user = interaction.member?.user;
  if (!user || !Number.isInteger(eventId)) {
    await reply('Could not tell who clicked.');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await upsertMember(env.DB, { discord_id: user.id, username: interaction.member?.nick ?? user.global_name ?? user.username, avatar_hash: user.avatar }, now);
  const url = `${origin}/events/${eventId}`;
  try {
    if (action === 'heart') {
      const on = await toggleInterest(env.DB, eventId, user.id, now);
      await reply(on ? `♥ Marked as interested. It shows under My events on the site: ${url}` : 'Interest removed.');
    } else if (action === 'go' || action === 'maybe') {
      const questions = await listEventQuestions(env.DB, eventId);
      if (questions.some((q) => q.required === 1)) {
        await reply(`This event asks a couple of questions first. Sign up on the site: ${url}`);
        return;
      }
      try {
        await setSignup(env.DB, eventId, user.id, action === 'go' ? 'yes' : 'maybe', now);
        const event = await getEvent(env.DB, eventId);
        await reply(action === 'go' ? `✅ You're going! ${event?.yes_count ?? ''} going now. Change it any time: ${url}` : `🤔 Marked as maybe. ${url}`);
      } catch (error) {
        if (error instanceof RuleError && error.code === 'full') {
          try {
            await joinWaitlist(env.DB, eventId, user.id, now);
            await reply(`It's full, so you're on the waitlist. When a seat frees you're moved to Going and told here. ${url}`);
          } catch (inner) {
            await reply(inner instanceof RuleError ? `${inner.message} ${url}` : 'Something went wrong.');
          }
          return;
        }
        throw error;
      }
      syncEventRolesInBackground(ctx, env.DB, env, [eventId], now);
      ctx.waitUntil(announcePromotions(env.DB, env, now).catch(() => {}));
    } else {
      await reply('Unknown button.');
      return;
    }
    await refreshEventAnnouncement(env.DB, env, eventId, origin);
  } catch (error) {
    await reply(error instanceof RuleError ? `${error.message} ${url}` : 'Something went wrong.');
  }
}

// --- /profile ------------------------------------------------------------------

async function handleProfile(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
  const invoker = interaction.member?.user;
  const picked = interaction.data?.options?.find((o) => o.name === 'user')?.value;
  const targetId = typeof picked === 'string' ? picked : invoker?.id;
  if (!targetId) {
    await editInteractionReply(interaction.application_id, interaction.token, 'Could not tell whose card to draw.');
    return;
  }
  // Hiding yourself from the leaderboard is a decision about your numbers
  // being public, so it also stops anybody else putting your card in a
  // channel. Your own card you can always draw.
  if (targetId !== invoker?.id && !(await isLeaderboardOptIn(env.DB, targetId))) {
    await editInteractionReply(interaction.application_id, interaction.token, 'That member keeps their card to themselves.');
    return;
  }
  const png = await profileCard(env, interaction, targetId, false, origin);
  if (!png) {
    await editInteractionReply(interaction.application_id, interaction.token, 'The card could not be drawn. Try again in a moment.');
    return;
  }
  const ok = await editInteractionReplyWithFile(
    interaction.application_id,
    interaction.token,
    '',
    { name: 'card.png', bytes: png, type: 'image/png' },
    turnButton(targetId, false, origin),
  );
  if (!ok) {
    await editInteractionReply(interaction.application_id, interaction.token, 'The card could not be posted. Try again in a moment.');
    return;
  }
  return 'keep';
}

// Two buttons under the card. Turning it over is for anyone looking at
// it — the back carries nothing the front does not already say out loud.
// The second is a plain link to the membership page, which is where the
// card comes from and where everything the card leaves out lives: the
// season, the events, the Minecraft names. It goes to whoever presses
// it, not to whoever the card is of, so it reads the same on anybody's.
function turnButton(targetId: string, showingBack: boolean, origin: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: showingBack ? 'Turn back' : 'Turn over', custom_id: `p:${showingBack ? 'f' : 'b'}:${targetId}` },
        { type: 2, style: 5, label: 'Membership page', url: `${origin}/membership` },
      ],
    },
  ];
}

// Turning the card over: the same picture from the other side, swapped
// into the message that is already there.
async function handleProfileTurn(env: WorkerEnv, interaction: Interaction, id: string, origin: string): Promise<Outcome> {
  const [, side, targetId] = id.split(':');
  const back = side === 'b';
  const png = await profileCard(env, interaction, targetId, back, origin);
  if (!png) return;
  await editInteractionReplyWithFile(
    interaction.application_id,
    interaction.token,
    '',
    { name: back ? 'card-back.png' : 'card.png', bytes: png, type: 'image/png' },
    turnButton(targetId, back, origin),
  );
  return 'keep';
}

// The card itself: the same code the membership page draws with, so the
// preview there cannot drift from what the channel sees.
async function profileCard(env: WorkerEnv, interaction: Interaction, targetId: string, back: boolean, origin: string): Promise<Uint8Array | null> {
  const invoker = interaction.member?.user;
  const resolved = interaction.data?.resolved?.users?.[targetId];
  const who = resolved ?? (targetId === invoker?.id ? invoker : undefined);
  // A button press carries no resolved user — Discord sends that only with
  // a command — so turning the card over knew neither the face's avatar nor
  // its name, and the card came back with the grey default on it. The cache
  // answers both, whoever is pressing.
  const cached = await cachedMember(env, targetId);
  const candidates = [
    targetId === invoker?.id ? interaction.member?.nick : interaction.data?.resolved?.members?.[targetId]?.nick,
    who?.global_name,
    who?.username,
    cached?.username,
  ].filter((n): n is string => Boolean(n));
  const name = candidates.find((n) => cleanText(n) === n.trim()) ?? candidates.map(cleanText).find((n) => n.length > 0) ?? 'Member';
  // Whose roles the interaction carries: the presser's always, the
  // picked user's with a command. Turning somebody else's card over
  // carries neither, and without them a board member's card came back in
  // the ordinary blue — so the bot is asked instead.
  const carried = targetId === invoker?.id ? interaction.member?.roles : interaction.data?.resolved?.members?.[targetId]?.roles;
  const roles = carried ?? (env.DISCORD_BOT_TOKEN ? ((await fetchGuildMemberRoles(env.DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, targetId)) ?? []) : []);
  try {
    const face = await cardFace(
      env.DB,
      {
        discordId: targetId,
        name,
        avatarHash: who?.avatar ?? cached?.avatar_hash ?? null,
        board: hasAdminRole(roles, env.ADMIN_ROLE_ID),
      },
      Math.floor(Date.now() / 1000),
    );
    return await memberCardPng(face, back, { origin, assets: env.ASSETS });
  } catch {
    return null;
  }
}

// The member cache, kept fresh on every sign-in and every roster touch.
// It is the fallback for both the name and the avatar when the
// interaction does not carry them, which is most of the time.
async function cachedMember(env: WorkerEnv, discordId: string): Promise<{ username: string; avatar_hash: string | null } | null> {
  return env.DB.prepare('SELECT username, avatar_hash FROM members WHERE discord_id = ?1')
    .bind(discordId)
    .first<{ username: string; avatar_hash: string | null }>();
}

// --- /board interactive panel ----------------------------------------------

// Two levels: /board opens the category chooser, a category button
// swaps the same ephemeral message to that category's actions, Back returns.
function controlPanel(origin: string): { content: string; components: unknown[] } {
  return {
    content: '<:lahtiag:1544775220458430565> **Board tools**. Pick a category:',
    components: [
      {
        type: 1,
        components: [
          // Secondary (grey) style: the blue brand emojis vanish on blurple.
          { type: 2, style: 2, label: 'Event', custom_id: 't:cat:event', emoji: { id: '1544775323722195184', name: 'lag_event' } },
          { type: 2, style: 2, label: 'Bracket', custom_id: 't:cat:bracket', emoji: { id: '1544775271486586890', name: 'lag_bracket' } },
          { type: 2, style: 2, label: 'Announce & screen', custom_id: 't:cat:comms', emoji: { id: '1544775849738502174', name: 'lag_news' } },
        ],
      },
      {
        // The board's pages on the site, one click away.
        type: 1,
        components: [
          { type: 2, style: 5, label: 'Whitelist', url: `${origin}/whitelist`, emoji: { name: '⛏️' } },
          { type: 2, style: 5, label: 'Season', url: `${origin}/board/season`, emoji: { name: '📈' } },
          { type: 2, style: 5, label: 'Register', url: `${origin}/register` },
          { type: 2, style: 5, label: 'News', url: `${origin}/announcements` },
        ],
      },
    ],
  };
}

function categoryPanel(category: string, origin: string): { content: string; components: unknown[] } {
  const back = { type: 2, style: 2, label: 'Back', custom_id: 't:cat:home', emoji: { name: '◀️' } };
  if (category === 'event') {
    return {
      content: '<:lag_event:1544775323722195184> **Event**. What needs doing?',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: 'Create event', custom_id: 't:create', emoji: { id: '1544775323722195184', name: 'lag_event' } },
            { type: 2, style: 2, label: 'Close signups', custom_id: 't:pick:close', emoji: { id: '1544775303543656448', name: 'lag_lock' } },
            { type: 2, style: 2, label: 'Reopen signups', custom_id: 't:pick:reopen', emoji: { id: '1544775287210774609', name: 'lag_unlock' } },
            { type: 2, style: 2, label: 'Cancel event', custom_id: 't:pick:cancel', emoji: { id: '1544775875592196137', name: 'lag_cancel' } },
            back,
          ],
        },
      ],
    };
  }
  if (category === 'bracket') {
    return {
      content: '<:lag_bracket:1544775271486586890> **Bracket**. What needs doing?',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: 'Generate bracket', custom_id: 't:pick:bracket', emoji: { id: '1544775271486586890', name: 'lag_bracket' } },
            { type: 2, style: 1, label: 'Go live', custom_id: 't:pick:live', emoji: { name: '🚀' } },
            { type: 2, style: 3, label: 'Record winner', custom_id: 't:pick:winner', emoji: { id: '1544775246429556808', name: 'lag_trophy' } },
            { type: 2, style: 2, label: 'Revert result', custom_id: 't:pick:undo', emoji: { name: '↩️' } },
            back,
          ],
        },
      ],
    };
  }
  if (category === 'comms') {
    return {
      content: '<:lag_news:1544775849738502174> **Announce & screen**. What needs doing?',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: 'Announce', custom_id: 't:announce', emoji: { id: '1544775849738502174', name: 'lag_news' } },
            { type: 2, style: 2, label: 'Screen message', custom_id: 't:pick:screen', emoji: { name: '💬' } },
            back,
          ],
        },
      ],
    };
  }
  return controlPanel(origin);
}

function announceModal() {
  const row = (component: Record<string, unknown>) => ({ type: 1, components: [component] });
  return {
    type: 9,
    data: {
      custom_id: 't:modal:announce',
      title: 'Publish an announcement',
      components: [
        row({ type: 4, custom_id: 'title', style: 1, label: 'Title', required: true, max_length: 120 }),
        row({ type: 4, custom_id: 'text', style: 2, label: 'Text (Markdown)', required: true, max_length: 2000 }),
      ],
    },
  };
}

function screenModal(eventId: string) {
  return {
    type: 9,
    data: {
      custom_id: `t:modal:screen:${eventId}`,
      title: 'Message on the venue screen',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'text',
              style: 2,
              label: 'Message (leave empty to clear)',
              required: false,
              max_length: 200,
            },
          ],
        },
      ],
    },
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

async function handleComponent(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
  const edit = (content: string, components: unknown[] = []) =>
    editInteractionReply(interaction.application_id, interaction.token, content, components);
  const customId = interaction.data!.custom_id!;
  const now = Math.floor(Date.now() / 1000);

  try {
    if (customId.startsWith('t:cat:')) {
      // Category navigation: swap the same ephemeral message between the
      // chooser and a category's actions.
      const category = customId.slice('t:cat:'.length);
      const panel = category === 'home' ? controlPanel(origin) : categoryPanel(category, origin);
      await edit(panel.content, panel.components);
      return 'keep';
    } else if (customId.startsWith('t:pick:')) {
      // Step 2: choose which event the action applies to.
      const action = customId.slice('t:pick:'.length);
      const events = await listUpcomingEvents(env.DB, now);
      if (events.length === 0) {
        await edit('No upcoming events to act on.');
        return;
      }
      const actionLabel =
        action === 'winner' ? 'record a winner for' : action === 'undo' ? 'revert a result on' : action === 'live' ? 'put the bracket live for' : action;
      await edit(`Pick the event to **${actionLabel}**:`, [
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
      return 'keep';
    } else if (customId.startsWith('t:do:')) {
      const action = customId.slice('t:do:'.length);
      const eventId = Number(interaction.data!.values?.[0]);
      if (action === 'close' || action === 'reopen') {
        await setSignupsClosed(env.DB, eventId, action === 'close', now);
        await postSignups(env.DB, env, eventId, action === 'close');
        await edit(action === 'close' ? `Signups closed for event #${eventId}.` : `Signups reopened for event #${eventId}.`);
      } else if (action === 'cancel') {
        const event = await cancelEvent(env.DB, eventId, now);
        if (env.DISCORD_WEBHOOK_URL) {
          await postWebhook(
            env.DISCORD_WEBHOOK_URL,
            `❌ Cancelled: **${event.title}** (was ${formatHelsinki(event.starts_at)})`,
          );
        }
        await syncScheduledEvent(env.DB, env, eventId, origin, now);
        await postEventLine(env.DB, env, eventId, cancelLine(event, true), true);
        await edit(`Cancelled event #${eventId}: **${event.title}**.`);
      } else if (action === 'bracket') {
        // The panel draws the event's one bracket. An event running
        // several is redrawn on the site, where you can say which.
        const brackets = await listBrackets(env.DB, eventId);
        if (brackets.length > 1) {
          await edit(`Event #${eventId} runs ${brackets.length} brackets — redraw the one you mean on the site: ${origin}/events/${eventId}/bracket`);
          return;
        }
        const target = brackets[0]?.id ?? (await createBracket(env.DB, eventId, null, now));
        await generateBracket(env.DB, target, now);
        if (brackets.length > 0) await dropLiveBracket(env.DB, env, target);
        await edit(`Bracket drafted; only the board sees it. Check the seeding on the site, then **Go live**: ${origin}/events/${eventId}/bracket`);
        return 'keep';
      } else if (action === 'live') {
        const drafts = (await listBrackets(env.DB, eventId)).filter((b) => b.live_at === null);
        if (drafts.length === 0) {
          await edit(`Nothing waiting on event #${eventId}: every bracket it has is already live. ${origin}/events/${eventId}/bracket`);
          return;
        }
        if (drafts.length > 1) {
          await edit('Which bracket goes live?', [
            {
              type: 1,
              components: [
                {
                  type: 3,
                  custom_id: `t:golive:${eventId}`,
                  options: drafts.slice(0, 25).map((b) => ({ label: b.name.slice(0, 100), value: String(b.id) })),
                },
              ],
            },
          ]);
          return 'keep';
        }
        const fresh = await goLiveBracket(env.DB, drafts[0].id, now);
        if (fresh) await postBracketOut(env.DB, env, drafts[0].id, origin, false);
        await edit(fresh ? `The bracket is live: ${origin}/events/${eventId}/bracket` : `The bracket was already live: ${origin}/events/${eventId}/bracket`);
      } else if (action === 'winner') {
        // Step 3: every ready, undecided match offers both possible winners.
        const names = await participantNames(env.DB, eventId);
        const nameOf = (key: string) => names.get(key) ?? 'Unknown';
        const brackets = await listBrackets(env.DB, eventId);
        const which = brackets.length > 1;
        const options = (
          await Promise.all(
            brackets.map(async (bracket) =>
              (await getBracket(env.DB, bracket.id))
                .filter((m) => m.winner === null && m.side_a !== null && m.side_b !== null)
                .flatMap((m) =>
                  [m.side_a!, m.side_b!].map((key, i) => ({
                    label: `${nameOf(key)} wins`.slice(0, 100),
                    description: `${which ? `${bracket.name} · ` : ''}R${m.round}: vs ${nameOf(i === 0 ? m.side_b! : m.side_a!)}`.slice(0, 100),
                    value: `${bracket.id}:${m.round}:${m.slot}:${key}`,
                  })),
                ),
            ),
          )
        )
          .flat()
          .slice(0, 25);
        if (options.length === 0) {
          await edit(`No undecided matches on event #${eventId}. ${origin}/events/${eventId}/bracket`);
          return;
        }
        await edit('Who won their match?', [
          { type: 1, components: [{ type: 3, custom_id: `t:win:${eventId}`, options }] },
        ]);
        return 'keep';
      } else if (action === 'undo') {
        // Step 3: every recorded (non-bye) result can be reverted.
        const names = await participantNames(env.DB, eventId);
        const nameOf = (key: string) => names.get(key) ?? 'Unknown';
        const brackets = await listBrackets(env.DB, eventId);
        const which = brackets.length > 1;
        const options = (
          await Promise.all(
            brackets.map(async (bracket) =>
              (await getBracket(env.DB, bracket.id))
                .filter((m) => m.winner !== null && m.side_a !== null && m.side_b !== null)
                .sort((a, b) => b.round - a.round || a.slot - b.slot)
                .map((m) => ({
                  label: `Undo: ${nameOf(m.winner!)} won R${m.round}`.slice(0, 100),
                  description: `${which ? `${bracket.name} · ` : ''}${nameOf(m.side_a!)} vs ${nameOf(m.side_b!)}`.slice(0, 100),
                  value: `${bracket.id}:${m.round}:${m.slot}`,
                })),
            ),
          )
        )
          .flat()
          .slice(0, 25);
        if (options.length === 0) {
          await edit(`No recorded results on event #${eventId}. ${origin}/events/${eventId}/bracket`);
          return;
        }
        await edit('Which result should be reverted?', [
          { type: 1, components: [{ type: 3, custom_id: `t:undo:${eventId}`, options }] },
        ]);
        return 'keep';
      }
    } else if (customId.startsWith('t:golive:')) {
      const eventId = Number(customId.slice('t:golive:'.length));
      const bracketId = Number(interaction.data!.values?.[0]);
      const fresh = await goLiveBracket(env.DB, bracketId, now);
      if (fresh) await postBracketOut(env.DB, env, bracketId, origin, false);
      await edit(`${fresh ? 'Live now' : 'Already live'}: ${origin}/events/${eventId}/bracket?b=${bracketId}`);
    } else if (customId.startsWith('t:undo:')) {
      const eventId = Number(customId.slice('t:undo:'.length));
      const [bracketId, round, slot] = String(interaction.data!.values?.[0]).split(':').map(Number);
      await clearBracketWinner(env.DB, bracketId, round, slot);
      await postRevert(env.DB, env, bracketId, origin, round, slot);
      await edit(
        `Reverted: the round ${round} match is undecided again, and everything that followed from it was cleared. ${origin}/events/${eventId}/bracket`,
      );
    } else if (customId.startsWith('t:win:')) {
      const eventId = Number(customId.slice('t:win:'.length));
      const [bracketId, round, slot, ...keyParts] = String(interaction.data!.values?.[0]).split(':');
      const key = keyParts.join(':');
      await setBracketWinner(env.DB, Number(bracketId), Number(round), Number(slot), key);
      await postResult(env.DB, env, Number(bracketId), origin, Number(round), Number(slot));
      const names = await participantNames(env.DB, eventId);
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

async function handleCreateModal(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
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
    await postEventAnnouncement(env.DB, env, id, origin);
    await syncScheduledEvent(env.DB, env, id, origin, now);
    await setUpEventDiscord(env.DB, env, id, origin, invoker.id, now);
    await reply(`Created event #${id}: **${title.trim()}**\n${origin}/events/${id}`);
    return 'keep';
  } catch (error) {
    await reply(error instanceof RuleError ? error.message : 'Something went wrong.');
  }
}

async function handleScreenModal(env: WorkerEnv, interaction: Interaction): Promise<void> {
  const reply = (content: string) =>
    editInteractionReply(interaction.application_id, interaction.token, content);
  try {
    const eventId = Number(interaction.data!.custom_id!.slice('t:modal:screen:'.length));
    let text = '';
    for (const modalRow of interaction.data!.components ?? []) {
      for (const component of modalRow.components) {
        if (component.custom_id === 'text') text = component.value ?? '';
      }
    }
    await setDisplayNote(env.DB, eventId, text.trim() || null);
    // The venue screen's line goes to the event's channel too, with a ping.
    if (text.trim()) await postEventLine(env.DB, env, eventId, screenLine(text.trim()), true);
    await reply(
      text.trim()
        ? `On screen within ten seconds: "${text.trim()}"`
        : 'Screen message cleared.',
    );
  } catch (error) {
    await reply(error instanceof RuleError ? error.message : 'Something went wrong.');
  }
}

async function handleAnnounceModal(env: WorkerEnv, interaction: Interaction, origin: string): Promise<void> {
  const reply = (content: string) =>
    editInteractionReply(interaction.application_id, interaction.token, content);
  try {
    const fields = new Map<string, string>();
    for (const modalRow of interaction.data!.components ?? []) {
      for (const component of modalRow.components) {
        fields.set(component.custom_id, component.value ?? '');
      }
    }
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
    const text = fields.get('text') ?? '';
    const id = await createAnnouncement(
      env.DB,
      { title, body_md: text, author_id: invoker.id, source: 'discord' },
      now,
    );
    if (env.DISCORD_WEBHOOK_URL) {
      const messageId = await postWebhook(env.DISCORD_WEBHOOK_URL, `📣 **${title.trim()}**\n${text}`);
      if (messageId) await setAnnouncementMessageId(env.DB, id, messageId);
    }
    await reply(`Published: **${title.trim()}**, ${origin}/announcements`);
  } catch (error) {
    await reply(error instanceof RuleError ? error.message : 'Something went wrong.');
  }
}

async function handleCommand(env: WorkerEnv, interaction: Interaction, origin: string): Promise<Outcome> {
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
      await postEventAnnouncement(env.DB, env, id, origin);
      await syncScheduledEvent(env.DB, env, id, origin, now);
      await setUpEventDiscord(env.DB, env, id, origin, invoker.id, now);
      await reply(`Created event #${id}: **${title.trim()}**, ${formatHelsinki(startsAt)}\n${origin}/events/${id}`);
      return 'keep';
    } else if (name === 'event cancel') {
      const id = Number(opts.get('id'));
      const event = await cancelEvent(env.DB, id, now);
      if (env.DISCORD_WEBHOOK_URL) {
        await postWebhook(
          env.DISCORD_WEBHOOK_URL,
          `❌ Cancelled: **${event.title}** (was ${formatHelsinki(event.starts_at)})`,
        );
      }
      await syncScheduledEvent(env.DB, env, id, origin, now);
      await postEventLine(env.DB, env, id, cancelLine(event, true), true);
      await reply(`Cancelled event #${id}: **${event.title}**.`);
    } else if (name === 'event close' || name === 'event reopen') {
      const id = Number(opts.get('id'));
      const closing = name === 'event close';
      await setSignupsClosed(env.DB, id, closing, now);
      await postSignups(env.DB, env, id, closing);
      await reply(closing ? `Signups closed for event #${id}.` : `Signups reopened for event #${id}.`);
    } else if (name === 'bracket generate') {
      const id = Number(opts.get('event'));
      const wanted = String(opts.get('name') ?? '').trim();
      const brackets = await listBrackets(env.DB, id);
      // With a name it is a new bracket beside the others; without one it
      // redraws the event's only bracket, which is the usual thing.
      if (wanted !== '') {
        const made = await addBracket(env.DB, id, wanted, now);
        await reply(`**${wanted}** drafted beside the event's other ${brackets.length === 1 ? 'bracket' : 'brackets'}; only the board sees it. Seed it and go live: ${origin}/events/${id}/bracket?b=${made}`);
        return 'keep';
      }
      if (brackets.length > 1) {
        await reply(`Event #${id} runs ${brackets.length} brackets, so name the one to redraw — or do it on the site: ${origin}/events/${id}/bracket`);
        return;
      }
      const target = brackets[0]?.id ?? (await createBracket(env.DB, id, null, now));
      await generateBracket(env.DB, target, now);
      if (brackets.length > 0) await dropLiveBracket(env.DB, env, target);
      await reply(`Bracket drafted; only the board sees it. Check the seeding on the site, then Go live (panel or site): ${origin}/events/${id}/bracket`);
      return 'keep';
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
      // Their next undecided match, in whichever of the event's brackets
      // it is waiting.
      const brackets = await listBrackets(env.DB, id);
      let found: { bracket: (typeof brackets)[number]; round: number; slot: number } | null = null;
      for (const bracket of brackets) {
        const match = (await getBracket(env.DB, bracket.id))
          .filter((m) => m.winner === null && m.side_a !== null && m.side_b !== null)
          .filter((m) => m.side_a === key || m.side_b === key)
          .sort((a, b) => a.round - b.round)[0];
        if (match && (found === null || match.round < found.round)) found = { bracket, round: match.round, slot: match.slot };
      }
      if (!found) {
        await reply(`No undecided match for "${opts.get('name')}" right now.`);
        return;
      }
      await setBracketWinner(env.DB, found.bracket.id, found.round, found.slot, key);
      await postResult(env.DB, env, found.bracket.id, origin, found.round, found.slot);
      const where = brackets.length > 1 ? ` of ${found.bracket.name}` : '';
      await reply(`Recorded: **${opts.get('name')}** wins round ${found.round}${where}. ${origin}/events/${id}/bracket`);
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
