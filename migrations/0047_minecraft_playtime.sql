-- Minecraft play time per player UUID, server and day, sampled from the
-- servers' own player statistics by scripts/minecraft/playtime-sync.py and
-- posted to /api/minecraft/playtime in batches that are applied once
-- (src/lib/playtime.ts). A member's time is the rows for their own names'
-- UUIDs (minecraft_names, kind 'own').
CREATE TABLE minecraft_playtime (
  uuid TEXT NOT NULL,
  server TEXT NOT NULL,
  day TEXT NOT NULL, -- 'YYYY-MM-DD', Helsinki time
  minutes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, server, day)
);

CREATE TABLE minecraft_playtime_batches (
  instance TEXT NOT NULL,
  seq INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (instance, seq)
);
