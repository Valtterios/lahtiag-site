-- An invite-only team (src/lib/db.ts joinEventTeam): nobody joins it on
-- their own; its captain adds people. The captain flips it on the event page.
ALTER TABLE event_teams ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
