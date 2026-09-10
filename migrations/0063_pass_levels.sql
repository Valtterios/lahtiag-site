-- The season pass's levels and who has reached them (src/lib/pass.ts).
-- A level is a rung on the season's XP track: at so many XP a member
-- reaches it and gets its reward. The board writes the levels for each
-- season on the season page; sponsors' names go on the levels they
-- pay for, as the sponsor letters promise. The reached table is the
-- ledger: one row per member and level, written the first time their
-- XP crosses the line, so a level is announced once and its reward is
-- given once. A level, once reached, stays reached: a tick removed or a
-- kind's XP lowered can take the XP back under the line, and the pass
-- does not take a reward back for that.
CREATE TABLE pass_levels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,          -- 2026 for the 2026–27 season
  level       INTEGER NOT NULL,          -- 1, 2, 3 … in XP order
  xp          INTEGER NOT NULL,          -- the XP that reaches it
  name        TEXT    NOT NULL,          -- 'Regular'
  reward      TEXT    NOT NULL,          -- 'Overall patch', 'Sticker pack'
  sponsor     TEXT,                      -- whose name is on the level, if anyone's
  role_id     TEXT,                      -- a Discord role the level gives, if any
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (season_year, level)
);

CREATE TABLE pass_reached (
  discord_id   TEXT    NOT NULL,
  level_id     INTEGER NOT NULL REFERENCES pass_levels(id) ON DELETE CASCADE,
  xp           INTEGER NOT NULL,         -- the XP they had when they crossed it
  reached_at   INTEGER NOT NULL,
  announced_at INTEGER,                  -- when the bot told the server (or the member, privately)
  PRIMARY KEY (discord_id, level_id)
);
