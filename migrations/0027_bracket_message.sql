-- The pinned "live bracket" message in the event's channel, edited by the
-- bot after every result (src/lib/event-channel.ts).
ALTER TABLE events ADD COLUMN discord_bracket_message_id TEXT;
