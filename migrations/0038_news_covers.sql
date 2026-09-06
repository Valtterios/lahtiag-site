-- A cover picture on a news post, shown on the news page and attached to
-- the Discord post (src/lib/db.ts, news covers). Own table like the event
-- covers, so listing posts never carries the bytes.
CREATE TABLE announcement_covers (
  announcement_id INTEGER PRIMARY KEY REFERENCES announcements(id),
  content_type    TEXT    NOT NULL,
  bytes           BLOB    NOT NULL,
  size            INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER
);
