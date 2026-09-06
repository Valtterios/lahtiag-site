-- Activity per day instead of per month, so weekly rules, streaks and
-- "active days" can be computed later, and a second table with the counts
-- per channel and day (no member dimension) for statistics. The counts so
-- far were a day old and are rebuilt by the listener from 1 September.
DROP TABLE discord_activity;

CREATE TABLE discord_activity (
  discord_id TEXT NOT NULL,
  day TEXT NOT NULL, -- 'YYYY-MM-DD', Helsinki time
  messages INTEGER NOT NULL DEFAULT 0,
  voice_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (discord_id, day)
);

CREATE TABLE discord_channel_activity (
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  voice_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, day)
);

DELETE FROM discord_activity_batches;
