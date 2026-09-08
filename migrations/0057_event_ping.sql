-- Who the event's announcement pings when it is published: NULL for
-- nobody, 'everyone', or a role id — the same three choices a news post
-- has (announcements.ping, src/lib/news.ts). Chosen on the Publish card,
-- and used again if the announcement is ever reposted.
ALTER TABLE events ADD COLUMN ping TEXT;
