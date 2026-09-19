-- Best-of matches (src/lib/scores.ts). A bracket is best-of-one unless
-- the board says otherwise, and its final may be longer than the rest —
-- "BO3 all the way, BO5 final" is the usual shape, and the only override
-- worth its own column.
ALTER TABLE brackets ADD COLUMN best_of INTEGER NOT NULL DEFAULT 1;
ALTER TABLE brackets ADD COLUMN final_best_of INTEGER; -- NULL = the same as the rest

-- Games won by each side. NULL is "no score recorded", which is every
-- match drawn before today and every best-of-one: those render exactly as
-- they always did.
ALTER TABLE bracket_matches ADD COLUMN score_a INTEGER;
ALTER TABLE bracket_matches ADD COLUMN score_b INTEGER;
