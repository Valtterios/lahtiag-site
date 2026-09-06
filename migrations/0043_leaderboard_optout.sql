-- The public leaderboard on the history page shows every member unless
-- they hide themselves on their membership page (board decision,
-- 2026-09-06). The old opt-in column stays, unused.
ALTER TABLE members ADD COLUMN leaderboard_hidden INTEGER NOT NULL DEFAULT 0;
