-- A mentionable Discord role per tournament team, so a team can be pinged
-- as @Team Name (src/lib/event-discord.ts). Only big events — the ones
-- with their own category — get them, so the server's 250-role budget is
-- spent on tournaments and reclaimed when they are archived or deleted.
--
-- The role id lives here rather than on event_teams because a disbanded
-- team's row is deleted, and the sync still has to find the role it left
-- behind. Same reason event_discord_channels is its own table.
CREATE TABLE event_team_roles (
  event_id      INTEGER NOT NULL REFERENCES events(id),
  event_team_id INTEGER NOT NULL,
  role_id       TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (event_id, event_team_id)
);

-- Who the bot gave a team role to, so a roster change costs one Discord
-- call and a departure knows whom to strip (mirrors event_role_grants).
CREATE TABLE event_team_role_grants (
  event_team_id INTEGER NOT NULL,
  discord_id    TEXT    NOT NULL,
  granted_at    INTEGER NOT NULL,
  PRIMARY KEY (event_team_id, discord_id)
);
CREATE INDEX idx_event_team_role_grants_member ON event_team_role_grants(discord_id);
