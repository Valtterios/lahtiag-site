-- A tournament team may carry more players than it fields: five on the
-- server and a sixth on the bench, swapped in between maps. team_reserves
-- is how many places a team has beyond team_size, and a signup sitting in
-- one of them is a reserve rather than part of the starting line-up.
ALTER TABLE events ADD COLUMN team_reserves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signups ADD COLUMN reserve INTEGER NOT NULL DEFAULT 0;
