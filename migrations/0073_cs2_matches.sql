-- A bracket match handed to one of the Counter-Strike servers.
--
-- The site is the controller: MatchZy-Enhanced pulls its match config from
-- /api/cs2/match/<id>.json and posts its events back to /api/cs2/events.
-- Every connection is outbound from the game server, so nothing here needs
-- to reach the home connection the servers sit behind.
--
-- One row per attempt. The row id IS the matchid the server is given:
-- MatchZy parses matchid as a 32-bit signed int, so a small counter is the
-- only shape that cannot overflow (a YYMMDDHHMM stamp does, and is rejected
-- with "matchid should be an integer!").
CREATE TABLE cs2_matches (
  id         INTEGER PRIMARY KEY,   -- = the matchid given to the server
  bracket_id INTEGER NOT NULL REFERENCES brackets(id) ON DELETE CASCADE,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  round      INTEGER NOT NULL,
  slot       INTEGER NOT NULL,
  server     TEXT    NOT NULL,      -- '1' or '2'
  best_of    INTEGER NOT NULL,

  -- The two sides as they stood when the match was sent. Frozen on purpose:
  -- a bracket edit afterwards must not silently change who the server is
  -- reporting about. side_a is team1, and team1 starts CT.
  side_a     TEXT NOT NULL,
  side_b     TEXT NOT NULL,
  name_a     TEXT NOT NULL,
  name_b     TEXT NOT NULL,

  -- pending  = config written, the server has not gone live yet
  -- live     = the server said going_live
  -- done     = series_end, or the bracket match was decided
  -- cancelled = withdrawn by the board; the server may still be playing it
  status     TEXT NOT NULL,

  -- When the game server was actually told to load this match.
  --
  -- A Cloudflare Worker cannot reach the servers, so the site cannot push a
  -- match onto one: it queues the match here and the bridge on the AMP host
  -- (scripts/cs2/lag_match.py bridge) polls for it and runs the load over
  -- RCON. This column is what makes that exactly-once. It matters more than
  -- it looks: matchzy_loadmatch over an autostarted live match SILENTLY
  -- DESTROYS it, so a queue that re-offered the same match every few
  -- seconds would be a machine for wrecking games.
  sent_at    INTEGER,

  -- What the SERVER last reported, which is not always what the bracket
  -- holds: the bracket is the record, this is the live picture.
  maps_a      INTEGER NOT NULL DEFAULT 0,
  maps_b      INTEGER NOT NULL DEFAULT 0,
  last_map_number INTEGER,          -- highest map_result seen; older ones are ignored
  current_map TEXT,
  rounds_a    INTEGER,              -- rounds in the map being played
  rounds_b    INTEGER,

  -- The winner this attempt last wrote into the bracket, if any. It is how
  -- "the board's word is final" is enforced: a bracket match already decided
  -- by something other than this attempt is left alone, so a late redelivery
  -- cannot rewind a result the board settled by hand.
  wrote_winner TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_cs2_matches_bracket ON cs2_matches(bracket_id, round, slot);
CREATE INDEX idx_cs2_matches_event ON cs2_matches(event_id);

-- A bracket match can only be on a server once at a time, and a server can
-- only be running one match at a time. Both are partial: a cancelled or
-- finished attempt leaves the slot and the server free again.
CREATE UNIQUE INDEX idx_cs2_matches_live_slot
  ON cs2_matches(bracket_id, round, slot) WHERE status IN ('pending', 'live');
CREATE UNIQUE INDEX idx_cs2_matches_live_server
  ON cs2_matches(server) WHERE status IN ('pending', 'live');
