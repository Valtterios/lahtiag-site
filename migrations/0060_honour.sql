-- The register's special roles, one picker instead of a founder flag:
-- founded the association, or served on a past board. Both carry the ink
-- card; the founder's badge is gold, the past board member's plain. The
-- `founder` column stays in the schema from here on but nothing reads or
-- writes it any more.
ALTER TABLE register ADD COLUMN honour TEXT;
UPDATE register SET honour = 'founder' WHERE founder = 1;
