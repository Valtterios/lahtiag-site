-- The board asking an applicant to put something right — a first name
-- where the association needs the full one, a misspelled address — with
-- the comment saying what. The entry stays pending and in the queue; the
-- note shows on the applicant's own membership page and is sent to them
-- on Discord when their account is linked, and it clears itself the
-- moment they save their details.
ALTER TABLE register ADD COLUMN fix_note TEXT;
ALTER TABLE register ADD COLUMN fix_asked_at INTEGER;
ALTER TABLE register ADD COLUMN fix_asked_by TEXT;
