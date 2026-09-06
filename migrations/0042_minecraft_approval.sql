-- A friend on a member's whitelist is an application: the board approves
-- it (site table or a button in the board channel) before the name goes
-- to the servers. Own and board names are approved as they are added;
-- everything from before counts as approved.
ALTER TABLE minecraft_names ADD COLUMN approved_at INTEGER;
ALTER TABLE minecraft_names ADD COLUMN approved_by TEXT;
UPDATE minecraft_names SET approved_at = added_at WHERE approved_at IS NULL;
