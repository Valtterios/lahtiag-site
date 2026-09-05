-- A member who applied before Discord linking existed (every imported row)
-- can ask, while signed in with Discord, to have that account linked to
-- their entry by giving the email they registered with. The request sits
-- on the entry until the board confirms or dismisses it. One pending
-- request per Discord account.
ALTER TABLE register ADD COLUMN link_discord_id TEXT;
ALTER TABLE register ADD COLUMN link_discord_name TEXT;
ALTER TABLE register ADD COLUMN link_requested_at INTEGER;

CREATE UNIQUE INDEX idx_register_link_discord ON register(link_discord_id) WHERE link_discord_id IS NOT NULL;
