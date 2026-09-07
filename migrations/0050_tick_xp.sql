-- What a tick is worth for the season pass: XP per kind, and how many
-- times a season the kind counts (0 = every time). A tick keeps the XP
-- it was given with, so last season's totals never move when the board
-- changes a kind; the season page can apply a change to the current
-- season's ticks as well. The first kind gets the board's outline: help
-- at an event, 100 XP, once a season.
ALTER TABLE tick_kinds ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tick_kinds ADD COLUMN season_cap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticks ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
UPDATE tick_kinds SET xp = 100, season_cap = 1 WHERE name = 'Helped at an event';
UPDATE ticks SET xp = 100 WHERE kind_id IN (SELECT id FROM tick_kinds WHERE name = 'Helped at an event');
