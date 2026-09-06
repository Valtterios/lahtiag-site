-- Milestones the bot has already cheered (src/lib/cron.ts, event-channel):
-- one row per person, kind and value, so a rerun never repeats one.
CREATE TABLE milestones (
  discord_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('events', 'wins')),
  value      INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (discord_id, kind, value)
);
