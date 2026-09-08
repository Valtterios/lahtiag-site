-- An event whose date nobody knows yet: a game update, a venue waiting on
-- a booking. starts_at stays a real number so every query that orders,
-- filters and counts by it goes on working — it is a placeholder, and
-- this flag is what stops the site stating it as fact. Nothing that needs
-- a true date (the reminder, the calendar feed, Discord's own event list)
-- runs while it is set.
ALTER TABLE events ADD COLUMN date_tba INTEGER NOT NULL DEFAULT 0;
