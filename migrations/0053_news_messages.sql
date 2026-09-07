-- A news post on Discord is several messages now (src/lib/news.ts): the
-- cover on its own, then the text in parts. Their ids, in order, as JSON
-- {"image": id or null, "parts": [ids]}; discord_message_id keeps the
-- first text part, and posts from before carry only that one message.
ALTER TABLE announcements ADD COLUMN discord_messages TEXT;
