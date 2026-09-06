-- Discord activity per member and month: messages sent and minutes in
-- voice on the LahtiAG server, counted by the listener on auraserver
-- (scripts/discord-listener) and posted to /api/discord/activity in
-- batches. Counts only, never a word of content. Each batch carries an
-- (instance, seq) pair so a retried batch is applied once.
CREATE TABLE discord_activity (
  discord_id TEXT NOT NULL,
  month TEXT NOT NULL, -- 'YYYY-MM', Helsinki time
  messages INTEGER NOT NULL DEFAULT 0,
  voice_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (discord_id, month)
);

CREATE TABLE discord_activity_batches (
  instance TEXT NOT NULL,
  seq INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (instance, seq)
);
