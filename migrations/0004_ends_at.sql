-- Events get an end time. Nullable for rows created before this; the forms
-- require it going forward. "Happening now" = starts_at <= now < ends_at.
ALTER TABLE events ADD COLUMN ends_at INTEGER;

-- Optional external link: a stream, rules doc, bracket elsewhere, venue map.
ALTER TABLE events ADD COLUMN link_url TEXT;
