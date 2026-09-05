-- The Discord message a cancellation posted, so reinstating the event can
-- take it down again.
ALTER TABLE events ADD COLUMN cancel_message_id TEXT;
