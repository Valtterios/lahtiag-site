-- A match for third place, played by the two beaten semifinalists
-- (src/lib/podium.ts). Opt-in per bracket: plenty of tournaments do not
-- play for third, and a bracket that skips it should not carry an
-- undecided match for ever.
--
-- The match itself is an ordinary row in the final round at slot 1 — the
-- final is slot 0 — so it needs no table of its own and every query that
-- reads a bracket finds it. What it does need is for "the final" to mean
-- slot 0 everywhere, which is what the code change alongside this is.
ALTER TABLE brackets ADD COLUMN bronze INTEGER NOT NULL DEFAULT 0;
