-- Coins (src/lib/coins.ts): play money for members, with no cash value and
-- no way to buy any. Every movement is a ledger row and a balance is the
-- sum; a bet is one row per member and event on who wins the bracket, and
-- the event's market says when betting opened, closed and was settled.
CREATE TABLE coin_ledger (
  id         INTEGER PRIMARY KEY,
  discord_id TEXT    NOT NULL,
  amount     INTEGER NOT NULL, -- signed: a stake goes out, a payout comes in
  kind       TEXT    NOT NULL CHECK (kind IN ('start', 'allowance', 'activity', 'bet', 'refund', 'payout', 'unsettle', 'purse', 'grant')),
  ref        TEXT,             -- 'event:<id>', 'week:<monday>', or null
  note       TEXT,
  created_by TEXT,             -- a board member's Discord id for a grant; null for the system
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_coin_ledger_member ON coin_ledger(discord_id, created_at);
CREATE UNIQUE INDEX idx_coin_ledger_once ON coin_ledger(discord_id, kind, ref) WHERE kind IN ('start', 'allowance', 'purse');

CREATE TABLE coin_markets (
  event_id   INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  opened_at  INTEGER NOT NULL,
  closed_at  INTEGER,
  settled_at INTEGER,
  winner     TEXT              -- the participant key the pool paid out on
);

CREATE TABLE coin_bets (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  discord_id TEXT    NOT NULL,
  pick       TEXT    NOT NULL, -- a participant key: 't:<team id>' or 'u:<discord id>'
  amount     INTEGER NOT NULL,
  placed_at  INTEGER NOT NULL,
  result     TEXT    CHECK (result IN ('won', 'lost', 'refunded')),
  payout     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, discord_id)
);
