-- A cover image per event, kept in its own table so event queries never
-- carry the bytes. Small images only (the upload route caps them).
CREATE TABLE event_covers (
  event_id     INTEGER PRIMARY KEY REFERENCES events(id),
  content_type TEXT    NOT NULL,
  bytes        BLOB    NOT NULL,
  size         INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
