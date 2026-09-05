-- Rebuild `register` for two things SQLite cannot add in place:
--   * `source` gains 'board': entries the board creates by hand (honorary
--     members invited by the general meeting, supporting members that are
--     companies, applications on paper);
--   * `search_key`: lower-cased, accent-stripped name/email/handles so
--     searching "aijo" finds "Äijö" (LIKE is ASCII-only).
-- Copy, drop, rename, recreate the indexes. Nothing references register.

CREATE TABLE register_v2 (
  id                INTEGER PRIMARY KEY,
  full_name         TEXT    NOT NULL,
  domicile          TEXT    NOT NULL,
  email             TEXT    NOT NULL,
  student_status    TEXT    NOT NULL CHECK (student_status IN ('LUT','LAB','alumni','other')),
  union_member      TEXT    NOT NULL CHECK (union_member IN ('LTKY','KOE','none')),
  member_type       TEXT    NOT NULL CHECK (member_type IN ('full','external','supporting','honorary')),
  telegram          TEXT,
  discord_name      TEXT,
  discord_id        TEXT,
  games             TEXT,
  wants_active      INTEGER NOT NULL DEFAULT 0,
  message           TEXT,
  board_note        TEXT,
  status            TEXT    NOT NULL CHECK (status IN ('pending','member','former')),
  source            TEXT    NOT NULL CHECK (source IN ('web','import','board')),
  applied_at        INTEGER NOT NULL,
  consented_at      INTEGER NOT NULL,
  decided_at        INTEGER,
  decided_by        TEXT,
  updated_at        INTEGER NOT NULL,
  link_discord_id   TEXT,
  link_discord_name TEXT,
  link_requested_at INTEGER,
  search_key        TEXT    NOT NULL DEFAULT ''
);

INSERT INTO register_v2 (id, full_name, domicile, email, student_status, union_member, member_type,
  telegram, discord_name, discord_id, games, wants_active, message, board_note, status, source,
  applied_at, consented_at, decided_at, decided_by, updated_at,
  link_discord_id, link_discord_name, link_requested_at, search_key)
SELECT id, full_name, domicile, email, student_status, union_member, member_type,
  telegram, discord_name, discord_id, games, wants_active, message, board_note, status, source,
  applied_at, consented_at, decided_at, decided_by, updated_at,
  link_discord_id, link_discord_name, link_requested_at,
  replace(replace(replace(replace(replace(replace(
    lower(full_name || ' ' || email || ' ' || coalesce(discord_name, '') || ' ' || coalesce(telegram, '')),
    'Ä', 'a'), 'Ö', 'o'), 'Å', 'a'), 'ä', 'a'), 'ö', 'o'), 'å', 'a')
FROM register;

DROP TABLE register;
ALTER TABLE register_v2 RENAME TO register;

CREATE INDEX idx_register_status ON register(status);
CREATE UNIQUE INDEX idx_register_email ON register(email COLLATE NOCASE);
CREATE UNIQUE INDEX idx_register_discord ON register(discord_id) WHERE discord_id IS NOT NULL;
CREATE UNIQUE INDEX idx_register_link_discord ON register(link_discord_id) WHERE link_discord_id IS NOT NULL;
