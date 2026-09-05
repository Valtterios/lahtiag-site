-- Drafts: an event is public once published; a news post likewise.
ALTER TABLE events ADD COLUMN published_at INTEGER;
UPDATE events SET published_at = created_at;
ALTER TABLE announcements ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
