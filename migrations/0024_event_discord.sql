-- A Discord role and a private channel per event, for everyone on the
-- roster (src/lib/event-discord.ts). The board switches it on from the
-- event page; the bot creates both. The grants table remembers who the
-- bot gave the role to, so a signup change costs one Discord call rather
-- than a listing of the whole server, and a departure knows whom to strip.
ALTER TABLE events ADD COLUMN discord_role_id TEXT;
ALTER TABLE events ADD COLUMN discord_channel_id TEXT;

CREATE TABLE event_role_grants (
  event_id   INTEGER NOT NULL REFERENCES events(id),
  discord_id TEXT    NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, discord_id)
);
CREATE INDEX idx_event_role_grants_member ON event_role_grants(discord_id);
