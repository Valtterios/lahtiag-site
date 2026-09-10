// One-time (and after any command change) registration of the slash
// commands, run locally:
//
//   DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... node scripts/register-commands.mjs
//
// Uses the client-credentials grant with the applications.commands.update
// scope, so no bot token exists anywhere — matching the spec's secret list.

const clientId = process.env.DISCORD_CLIENT_ID;
const clientSecret = process.env.DISCORD_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in the environment.');
  process.exit(1);
}

const STRING = 3;
const INTEGER = 4;
const USER = 6;

const SUB_COMMAND = 1;

// Which server a whitelisted name is for; every server unless narrowed.
// Keep the values in step with SERVERS in src/lib/minecraft.ts.
const SERVER_CHOICE = {
  type: STRING,
  name: 'server',
  description: 'Which server (every server unless you pick one)',
  required: false,
  choices: [
    { name: 'All servers', value: 'all' },
    { name: 'SMP only', value: 'smp' },
    { name: 'GT:NH modpack only', value: 'gtnh' },
  ],
};

const commands = [
  {
    name: 'event',
    description: 'Manage LahtiAG events',
    options: [
      {
        type: SUB_COMMAND,
        name: 'create',
        description: 'Create an event',
        options: [
          { type: STRING, name: 'name', description: 'Event title', required: true },
          { type: STRING, name: 'date', description: 'YYYY-MM-DD (Helsinki)', required: true },
          { type: STRING, name: 'time', description: 'Start HH:MM (Helsinki)', required: true },
          { type: STRING, name: 'end_time', description: 'End HH:MM (Helsinki; past midnight rolls to next day)', required: false },
          { type: INTEGER, name: 'capacity', description: 'Max signups (people, or teams for a team event)', required: false, min_value: 1 },
          { type: INTEGER, name: 'team_size', description: 'Players per team; set to make this a team event', required: false, min_value: 1 },
          { type: STRING, name: 'organizers', description: 'Organizer names, comma separated', required: false },
          { type: STRING, name: 'link', description: 'Stream or info link (https)', required: false },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'cancel',
        description: 'Cancel an event',
        options: [{ type: INTEGER, name: 'id', description: 'Event id', required: true }],
      },
      {
        type: SUB_COMMAND,
        name: 'close',
        description: 'Close signups (before generating the bracket)',
        options: [{ type: INTEGER, name: 'id', description: 'Event id', required: true }],
      },
      {
        type: SUB_COMMAND,
        name: 'reopen',
        description: 'Reopen signups',
        options: [{ type: INTEGER, name: 'id', description: 'Event id', required: true }],
      },
    ],
  },
  {
    name: 'bracket',
    description: 'Run a tournament bracket',
    options: [
      {
        type: SUB_COMMAND,
        name: 'generate',
        description: 'Draw the bracket from signups; a name draws another one beside it',
        options: [
          { type: INTEGER, name: 'event', description: 'Event id', required: true },
          { type: STRING, name: 'name', description: 'Name a second bracket (a plate, a group, another game)', required: false },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'win',
        description: 'Record a match winner by team or player name',
        options: [
          { type: INTEGER, name: 'event', description: 'Event id', required: true },
          { type: STRING, name: 'name', description: 'Winning team or player name', required: true },
        ],
      },
    ],
  },
  {
    name: 'board',
    description: 'Board tools: events, brackets, announcements, whitelist, register, news',
  },
  {
    name: 'announce',
    description: 'Publish an announcement to the site',
    options: [{ type: STRING, name: 'text', description: 'Announcement text (Markdown)', required: true }],
  },
  {
    name: 'membership',
    description: 'Your LahtiAG membership status (only you see the answer)',
  },
  { name: 'roll', description: 'Roll dice', options: [{ type: INTEGER, name: 'sides', description: 'Sides (default 6)', required: false, min_value: 2, max_value: 1000 }, { type: INTEGER, name: 'count', description: 'How many dice (default 1)', required: false, min_value: 1, max_value: 10 }] },
  { name: 'coin', description: 'Flip a coin' },
  { name: 'pick', description: 'Let the bot choose', options: [{ type: STRING, name: 'options', description: 'Options, separated by commas', required: true }] },
  { name: 'next', description: 'The next LahtiAG events' },
  { name: 'champion', description: 'Who holds the latest tournament title' },
  {
    name: 'profile',
    description: 'Your LahtiAG stats card: events, tournaments, wins (everyone sees it)',
    options: [{ type: 6, name: 'user', description: "Someone else's card", required: false }],
  },
  {
    name: 'join',
    description: 'Become a LahtiAG member, or link your Discord to your membership',
  },
  { name: 'season', description: 'Your season so far: events, Discord activity, Minecraft play time, XP' },
  {
    name: 'pass',
    description: 'Your battle pass as a picture: XP, level, and the rewards (everyone sees it)',
    options: [{ type: 6, name: 'user', description: "Someone else's pass", required: false }],
  },
  { name: 'claim', description: 'Claim a tick for the battle pass; the board approves it' },
  { name: 'xp', description: 'How to earn battle pass XP, and what you have collected so far' },
  { name: 'leaderboard', description: "This season's XP leaderboard (everyone sees it)" },
  {
    name: 'whitelist',
    description: 'The LahtiAG Minecraft servers\' whitelist',
    options: [
      {
        type: SUB_COMMAND,
        name: 'me',
        description: 'Put your own Minecraft name on the whitelist (members, every server)',
        options: [{ type: STRING, name: 'name', description: 'Your Java edition name', required: true }],
      },
      {
        type: SUB_COMMAND,
        name: 'friend',
        description: 'Ask the board to whitelist a friend on your membership (two at most)',
        options: [{ type: STRING, name: 'name', description: "Your friend's Java edition name", required: true }, SERVER_CHOICE],
      },
      {
        type: SUB_COMMAND,
        name: 'remove',
        description: 'Take one of your names off the list',
        options: [{ type: STRING, name: 'name', description: 'The name', required: true }],
      },
      { type: SUB_COMMAND, name: 'list', description: 'Your names on the whitelist' },
      {
        type: SUB_COMMAND,
        name: 'add',
        description: 'Board: whitelist any name, membership or not',
        options: [{ type: STRING, name: 'name', description: 'The Java edition name', required: true }, SERVER_CHOICE],
      },
      {
        type: SUB_COMMAND,
        name: 'link',
        description: 'Board: hand a board name to the member it belongs to',
        options: [
          { type: STRING, name: 'name', description: 'The Java edition name, one of the board names', required: true },
          { type: USER, name: 'member', description: 'Whose name it is', required: true },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'drop',
        description: 'Board: take any name off the list',
        options: [{ type: STRING, name: 'name', description: 'The name', required: true }],
      },
      { type: SUB_COMMAND, name: 'pending', description: 'Board: friend requests waiting for a decision' },
      {
        type: SUB_COMMAND,
        name: 'approve',
        description: 'Board: approve a waiting friend',
        options: [{ type: STRING, name: 'name', description: 'The name', required: true }],
      },
      {
        type: SUB_COMMAND,
        name: 'decline',
        description: 'Board: turn a waiting friend down',
        options: [{ type: STRING, name: 'name', description: 'The name', required: true }],
      },
    ],
  },
];

const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
  method: 'POST',
  headers: {
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'applications.commands.update',
  }),
});
if (!tokenResponse.ok) {
  console.error('Token request failed:', tokenResponse.status, await tokenResponse.text());
  process.exit(1);
}
const { access_token: accessToken } = await tokenResponse.json();

const putResponse = await fetch(`https://discord.com/api/v10/applications/${clientId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!putResponse.ok) {
  console.error('Command registration failed:', putResponse.status, await putResponse.text());
  process.exit(1);
}
const registered = await putResponse.json();
console.log(`Registered ${registered.length} commands:`, registered.map((c) => c.name).join(', '));
