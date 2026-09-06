-- A big event's own Discord category, and every channel the bot made for
-- an event (src/lib/event-discord.ts), so archive and delete know what is
-- theirs and team voice channels know which teams already have one.
ALTER TABLE events ADD COLUMN discord_category_id TEXT;

CREATE TABLE event_discord_channels (
  event_id      INTEGER NOT NULL REFERENCES events(id),
  channel_id    TEXT    NOT NULL,
  kind          TEXT    NOT NULL, -- discussion, rules, teams, commentators, interviews, team
  event_team_id INTEGER,          -- kind 'team': whose voice channel
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (event_id, channel_id)
);
