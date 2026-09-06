-- Who a news post pings on Discord when it goes out: NULL for nobody,
-- 'everyone', or a role id (src/lib/news.ts).
ALTER TABLE announcements ADD COLUMN ping TEXT;
