-- The hourly job's "ticket sales close tomorrow" line, once per event.
ALTER TABLE events ADD COLUMN sales_reminder_sent_at INTEGER;
