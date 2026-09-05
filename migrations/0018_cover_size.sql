-- Covers keep their pixel size so the page reserves the right box.
ALTER TABLE event_covers ADD COLUMN width INTEGER;
ALTER TABLE event_covers ADD COLUMN height INTEGER;
