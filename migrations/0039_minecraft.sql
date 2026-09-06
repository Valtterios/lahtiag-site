-- The Minecraft server's whitelist (src/lib/minecraft.ts): a member's own
-- Java name, a couple of friends on their membership, and names the board
-- adds by hand. The server pulls the list from /api/minecraft/whitelist.
CREATE TABLE minecraft_names (
  id         INTEGER PRIMARY KEY,
  discord_id TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('own', 'friend', 'board')),
  added_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_minecraft_name ON minecraft_names(name COLLATE NOCASE);
CREATE INDEX idx_minecraft_owner ON minecraft_names(discord_id);
