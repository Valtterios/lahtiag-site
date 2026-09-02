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
    ],
  },
  {
    name: 'announce',
    description: 'Publish an announcement to the site',
    options: [{ type: STRING, name: 'text', description: 'Announcement text (Markdown)', required: true }],
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
