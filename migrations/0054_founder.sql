-- The people who founded the association. It is not a class of membership
-- and not a role anyone is elected to, so it is its own flag: a permanent
-- fact about a person, set once by the board on their register entry, and
-- worn as a gold badge on their membership card.
ALTER TABLE register ADD COLUMN founder INTEGER NOT NULL DEFAULT 0;
