-- Ticks: the things the board notes by hand for the season pass, such as
-- helping at an event, which nothing can count on its own. The kinds are
-- a list the board keeps on the season page (src/lib/ticks.ts); a tick is
-- one kind given to one register entry, by a board member, optionally
-- for one event. A retired kind keeps the ticks already given under it.
CREATE TABLE tick_kinds (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  retired_at  INTEGER,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE ticks (
  id          INTEGER PRIMARY KEY,
  kind_id     INTEGER NOT NULL REFERENCES tick_kinds(id),
  register_id INTEGER NOT NULL REFERENCES register(id) ON DELETE CASCADE,
  event_id    INTEGER REFERENCES events(id) ON DELETE SET NULL,
  note        TEXT,
  given_by    TEXT    NOT NULL,
  given_at    INTEGER NOT NULL
);
CREATE INDEX idx_ticks_member ON ticks(register_id, given_at);
CREATE INDEX idx_ticks_event ON ticks(event_id);
-- The same tick for the same event only once; without an event, as often
-- as the board sees fit.
CREATE UNIQUE INDEX idx_ticks_once_per_event ON ticks(kind_id, register_id, event_id) WHERE event_id IS NOT NULL;

INSERT INTO tick_kinds (name, description, sort, created_by, created_at)
VALUES ('Helped at an event', 'Set up, ran or packed up an event.', 1, 'setup', strftime('%s', 'now'));
