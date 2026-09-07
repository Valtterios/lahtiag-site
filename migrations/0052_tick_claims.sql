-- Claims: a member asks for a tick (/claim in Discord, or the button under
-- /season and the leaderboard), the board approves or declines it in the
-- board channel or on the season page, and approving gives the tick. Only
-- kinds the board has marked claimable can be asked for; helping at an
-- event is, from the start.
ALTER TABLE tick_kinds ADD COLUMN claimable INTEGER NOT NULL DEFAULT 0;
UPDATE tick_kinds SET claimable = 1 WHERE name = 'Helped at an event';

CREATE TABLE tick_claims (
  id          INTEGER PRIMARY KEY,
  kind_id     INTEGER NOT NULL REFERENCES tick_kinds(id),
  register_id INTEGER NOT NULL REFERENCES register(id) ON DELETE CASCADE,
  discord_id  TEXT    NOT NULL, -- who asked, for the DM with the decision
  event_id    INTEGER REFERENCES events(id) ON DELETE SET NULL,
  note        TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  tick_id     INTEGER, -- the tick given on approval
  created_at  INTEGER NOT NULL,
  decided_by  TEXT,
  decided_at  INTEGER
);
CREATE INDEX idx_tick_claims_member ON tick_claims(register_id, created_at);
CREATE INDEX idx_tick_claims_status ON tick_claims(status, created_at);
