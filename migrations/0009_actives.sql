-- Actives become a decision, not a self-set flag: `wants_active` is the
-- member's request (from the form or the join page), `is_active` the
-- board's approval, with when and by whom. Approved actives get the
-- Actives role on Discord (src/lib/roles.ts) when their account is linked.
ALTER TABLE register ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE register ADD COLUMN active_since INTEGER;
ALTER TABLE register ADD COLUMN active_by TEXT;
