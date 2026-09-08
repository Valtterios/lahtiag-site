-- When signups close by themselves, the mirror of signups_open_at: the
-- quarter-hourly job closes the event and posts the line within fifteen
-- minutes of this moment. signups_closed_at stays what it always was —
-- the moment they actually closed, by hand or by this.
ALTER TABLE events ADD COLUMN signups_close_at INTEGER;
