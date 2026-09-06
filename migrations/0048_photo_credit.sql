-- Who took an event's photos, shown under them on the event page and on
-- the history page's album, instead of one credit line for every event.
ALTER TABLE events ADD COLUMN photo_credit TEXT;
