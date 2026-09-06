-- A draft news post with a publish time: the 15-minute job publishes it
-- and posts it to Discord (src/lib/cron.ts).
ALTER TABLE announcements ADD COLUMN publish_at INTEGER;
