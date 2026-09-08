-- An event runs as many brackets as it needs, each under its own name: a
-- main draw and a consolation, two games at one LAN, a bracket per group.
-- Each keeps its own draft/live state and its own pinned message in
-- Discord — both of which used to sit on the event, which is why there
-- could only ever be one.

CREATE TABLE brackets (
  id                 INTEGER PRIMARY KEY,
  event_id           INTEGER NOT NULL REFERENCES events(id),
  name               TEXT    NOT NULL,
  live_at            INTEGER,      -- NULL = a draft only the board sees
  discord_message_id TEXT,         -- its own pinned live bracket
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_brackets_event ON brackets(event_id);
CREATE UNIQUE INDEX idx_brackets_name ON brackets(event_id, name COLLATE NOCASE);

-- Every bracket drawn so far becomes its event's first one, carrying the
-- state the event was holding for it. events.bracket_live_at and
-- events.discord_bracket_message_id stay in the schema from here on but
-- nothing reads or writes them any more.
INSERT INTO brackets (event_id, name, live_at, discord_message_id, created_at)
SELECT e.id, 'Main bracket', e.bracket_live_at, e.discord_bracket_message_id, e.created_at
  FROM events e
 WHERE EXISTS (SELECT 1 FROM bracket_matches b WHERE b.event_id = e.id);

-- A match belongs to a bracket now. event_id stays alongside it: the
-- results archive, the leaderboard and a member's stats all ask their
-- questions by event, and would otherwise join through every time.
CREATE TABLE bracket_matches_2 (
  bracket_id INTEGER NOT NULL REFERENCES brackets(id) ON DELETE CASCADE,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  round      INTEGER NOT NULL, -- 1-based; the highest round is the final
  slot       INTEGER NOT NULL, -- 0-based position within the round
  side_a     TEXT,
  side_b     TEXT,
  winner     TEXT,
  PRIMARY KEY (bracket_id, round, slot)
);

INSERT INTO bracket_matches_2 (bracket_id, event_id, round, slot, side_a, side_b, winner)
SELECT br.id, bm.event_id, bm.round, bm.slot, bm.side_a, bm.side_b, bm.winner
  FROM bracket_matches bm
  JOIN brackets br ON br.event_id = bm.event_id;

DROP TABLE bracket_matches;
ALTER TABLE bracket_matches_2 RENAME TO bracket_matches;
CREATE INDEX idx_bracket_matches_event ON bracket_matches(event_id);
