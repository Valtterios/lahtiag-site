-- A generated bracket starts as a draft the board can reseed; "Go live"
-- shows it to everyone and posts it to Discord (src/lib/db.ts, bracket).
ALTER TABLE events ADD COLUMN bracket_live_at INTEGER;
-- Brackets that exist today were live from the moment they were made.
UPDATE events SET bracket_live_at = created_at WHERE id IN (SELECT DISTINCT event_id FROM bracket_matches);
