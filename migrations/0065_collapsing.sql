-- Messages that fold up after a while (src/lib/collapse.ts): the /pass
-- and /profile pictures, posted for everyone, which the cron turns into
-- a one-line footprint a minute or so later so a channel is not a wall
-- of cards. One row per message with the text it folds to; the row goes
-- when the fold is done.
CREATE TABLE collapsing_messages (
  channel_id  TEXT    NOT NULL,
  message_id  TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  collapse_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
