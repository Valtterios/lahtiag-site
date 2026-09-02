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
          { type: STRING, name: 'time', description: 'HH:MM (Helsinki)', required: true },
          { type: INTEGER, name: 'capacity', description: 'Max "going" signups', required: false, min_value: 1 },
          { type: STRING, name: 'team', description: 'Team name, if team-specific', required: false },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'cancel',
        description: 'Cancel an event',
        options: [{ type: INTEGER, name: 'id', description: 'Event id', required: true }],
      },
    ],
  },
  {
    name: 'announce',
    description: 'Publish an announcement to the site',
    options: [{ type: STRING, name: 'text', description: 'Announcement text (Markdown)', required: true }],
  },
  {
    name: 'roster',
    description: 'Manage team rosters',
    options: [
      {
        type: SUB_COMMAND,
        name: 'add',
        description: 'Add a member to a team',
        options: [
          { type: USER, name: 'user', description: 'Member', required: true },
          { type: STRING, name: 'team', description: 'Team name', required: true },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'remove',
        description: 'Remove a member from a team',
        options: [
          { type: USER, name: 'user', description: 'Member', required: true },
          { type: STRING, name: 'team', description: 'Team name', required: true },
        ],
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
