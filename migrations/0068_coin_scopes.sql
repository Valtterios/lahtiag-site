-- A bet can be on a single match as well as on the tournament winner:
-- the market and the bet carry a scope, 'winner' for the bracket's
-- champion or 'm:<bracket>:<round>:<slot>' for one match. The tables are
-- rebuilt because SQLite cannot change a primary key; they were empty.
DROP TABLE coin_bets;
DROP TABLE coin_markets;
CREATE TABLE coin_markets (
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  scope      TEXT    NOT NULL,
  opened_at  INTEGER NOT NULL,
  closed_at  INTEGER,
  settled_at INTEGER,
  winner     TEXT,
  PRIMARY KEY (event_id, scope)
);
CREATE TABLE coin_bets (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  scope      TEXT    NOT NULL,
  discord_id TEXT    NOT NULL,
  pick       TEXT    NOT NULL,
  amount     INTEGER NOT NULL,
  placed_at  INTEGER NOT NULL,
  result     TEXT    CHECK (result IN ('won', 'lost', 'refunded')),
  payout     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, scope, discord_id)
);
