-- "Signups open at" and the Interested heart: an event can take interest
-- before signups open, counted together with Discord's own Interested
-- clicks on the scheduled event (src/lib/event-discord.ts syncInterest).
ALTER TABLE events ADD COLUMN signups_open_at INTEGER;
ALTER TABLE events ADD COLUMN interest_synced_at INTEGER;

CREATE TABLE event_interest (
  event_id   INTEGER NOT NULL REFERENCES events(id),
  discord_id TEXT    NOT NULL,
  source     TEXT    NOT NULL CHECK (source IN ('site', 'discord')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, discord_id, source)
);
