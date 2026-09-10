-- Where each player is in the GT:NH modpack (src/lib/gtnh.ts): the quest
-- book's tier chapters with how many of each chapter's quests the player
-- has done, read from the server's own BetterQuesting files by the bridge
-- on the host (scripts/minecraft/bridge/bridge.mjs) and posted to
-- /api/minecraft/progress as a snapshot per player. The tier is computed
-- here from the chapters, so the rule lives in one place.
CREATE TABLE minecraft_progress (
  uuid TEXT NOT NULL,
  server TEXT NOT NULL,
  name TEXT NOT NULL, -- the player's name as the server last saw it
  tier TEXT, -- the tier key reached (GTNH_TIERS), null before the first quest
  tier_since INTEGER, -- when that tier was first seen
  lines TEXT NOT NULL, -- JSON: { "lv": { "done": 14, "total": 155 }, ... }
  quests_done INTEGER NOT NULL DEFAULT 0,
  quests_total INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, server)
);
