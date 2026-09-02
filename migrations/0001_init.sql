-- Phase 2 initial schema, verbatim from the design spec
-- (docs/superpowers/specs/2026-09-02-lahtiag-website-design.md).
-- Times are UTC unix integers; rendering to Europe/Helsinki happens in code.

CREATE TABLE members (
  discord_id   TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  avatar_hash  TEXT,
  last_seen    INTEGER NOT NULL
);

CREATE TABLE teams (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  game    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE team_members (
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  discord_id TEXT    NOT NULL REFERENCES members(discord_id),
  position   TEXT,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, discord_id)
);

CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT,
  starts_at          INTEGER NOT NULL,
  capacity           INTEGER,
  team_id            INTEGER REFERENCES teams(id),
  created_by         TEXT NOT NULL REFERENCES members(discord_id),
  created_at         INTEGER NOT NULL,
  cancelled_at       INTEGER,
  discord_message_id TEXT
);

CREATE TABLE signups (
  event_id   INTEGER NOT NULL REFERENCES events(id),
  discord_id TEXT    NOT NULL REFERENCES members(discord_id),
  status     TEXT    NOT NULL CHECK (status IN ('yes','maybe')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, discord_id)
);

CREATE TABLE announcements (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  body_md            TEXT NOT NULL,
  published_at       INTEGER NOT NULL,
  author_id          TEXT NOT NULL REFERENCES members(discord_id),
  source             TEXT NOT NULL CHECK (source IN ('web','discord')),
  discord_message_id TEXT
);

CREATE INDEX idx_events_starts_at ON events(starts_at);
CREATE INDEX idx_signups_event    ON signups(event_id);
