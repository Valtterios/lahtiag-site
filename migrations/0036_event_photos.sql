-- Photos of an event, uploaded by the board after the fact, shown on the
-- event page and the history page (src/lib/db.ts, photos). The browser
-- shrinks them before upload (a 1600 px picture and a small thumbnail).
CREATE TABLE event_photos (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  content_type TEXT    NOT NULL,
  bytes        BLOB    NOT NULL,
  thumb        BLOB,
  size         INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_event_photos_event ON event_photos(event_id, sort, id);
