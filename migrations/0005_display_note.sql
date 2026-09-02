-- One live message per event for the venue display, set from Discord's
-- /tournament panel and shown by the bracket's presenter mode.
ALTER TABLE events ADD COLUMN display_note TEXT;
