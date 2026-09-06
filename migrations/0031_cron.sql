-- What the hourly job has already done for an event (src/lib/cron.ts):
-- the day-before reminder, and the "signups are open" post.
ALTER TABLE events ADD COLUMN reminder_sent_at INTEGER;
ALTER TABLE events ADD COLUMN open_posted_at INTEGER;
