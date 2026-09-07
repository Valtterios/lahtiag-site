-- The period a kind's cap counts in: per season (as before), per month or
-- per week, judged by when the tick was given, Helsinki time. Nothing is
-- stored per period; the season pass groups a member's ticks by kind and
-- period when it adds the XP up (src/lib/ticks.ts, applyCaps).
ALTER TABLE tick_kinds ADD COLUMN period TEXT NOT NULL DEFAULT 'season' CHECK (period IN ('season', 'month', 'week'));
