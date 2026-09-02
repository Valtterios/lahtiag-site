-- Single-elimination tournament brackets, one per event, generated from the
-- event's signups. A participant key is 'u:<discord_id>' on solo events and
-- 't:<event_team_id>' on team events. NULL side = bye (round 1) or
-- to-be-decided (later rounds). winner always equals one of the sides.

-- Admins can close signups ahead of the event (typically before generating
-- the bracket) without cancelling it. NULL = open.
ALTER TABLE events ADD COLUMN signups_closed_at INTEGER;

CREATE TABLE bracket_matches (
  event_id INTEGER NOT NULL REFERENCES events(id),
  round    INTEGER NOT NULL, -- 1-based; the highest round is the final
  slot     INTEGER NOT NULL, -- 0-based position within the round
  side_a   TEXT,
  side_b   TEXT,
  winner   TEXT,
  PRIMARY KEY (event_id, round, slot)
);
