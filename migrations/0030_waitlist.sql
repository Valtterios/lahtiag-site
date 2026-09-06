-- A waitlist for full events (solo, capped, no tickets): first come, first
-- promoted when a seat frees. Promotions are logged so the bot can tell
-- the person in the event's channel afterwards (src/lib/event-channel.ts).
CREATE TABLE event_waitlist (
  event_id   INTEGER NOT NULL REFERENCES events(id),
  discord_id TEXT    NOT NULL REFERENCES members(discord_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, discord_id)
);

CREATE TABLE waitlist_promotions (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  discord_id   TEXT    NOT NULL,
  promoted_at  INTEGER NOT NULL,
  announced_at INTEGER
);
CREATE INDEX idx_waitlist_promotions_open ON waitlist_promotions(announced_at) WHERE announced_at IS NULL;
