-- The Discord scheduled event the bot creates when an event is published
-- (src/lib/event-discord.ts): updated on edit, removed on cancel or delete.
ALTER TABLE events ADD COLUMN discord_event_id TEXT;
