-- Opt-in to the public leaderboard on the history page (src/lib/db.ts
-- leaderboard). Off for everyone until they tick it on their membership page.
ALTER TABLE members ADD COLUMN leaderboard INTEGER NOT NULL DEFAULT 0;
