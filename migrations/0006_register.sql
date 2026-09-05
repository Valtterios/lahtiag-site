-- The association's member register (jäsenluettelo). The Associations Act
-- (yhdistyslaki 11 §) obliges the board to keep one listing each member's
-- full name and domicile; everything else here is what the old Google Form
-- collected. This is a separate table from `members`, which is only a
-- display cache of Discord accounts: a person can be in the register
-- without Discord, and in Discord without being a member. `discord_id`
-- links the two when an applicant was signed in, or when the board links
-- them by hand.
--
-- status: 'pending' (applied, board has not decided), 'member', 'former'
-- (resigned or removed, kept until the board erases the row). A rejected
-- application is deleted outright.

CREATE TABLE register (
  id             INTEGER PRIMARY KEY,
  full_name      TEXT    NOT NULL,
  domicile       TEXT    NOT NULL,
  email          TEXT    NOT NULL,
  student_status TEXT    NOT NULL CHECK (student_status IN ('LUT','LAB','alumni','other')),
  union_member   TEXT    NOT NULL CHECK (union_member IN ('LTKY','KOE','none')),
  member_type    TEXT    NOT NULL CHECK (member_type IN ('full','external','supporting','honorary')),  -- rules 4 §; full/external derived from student_status, board can change
  telegram       TEXT,
  discord_name   TEXT,
  discord_id     TEXT,
  games          TEXT,            -- comma-separated, from the fixed list plus free text
  wants_active   INTEGER NOT NULL DEFAULT 0,
  message        TEXT,            -- the applicant's "Questions?" field
  board_note     TEXT,            -- board's own remarks, never shown to the member
  status         TEXT    NOT NULL CHECK (status IN ('pending','member','former')),
  source         TEXT    NOT NULL CHECK (source IN ('web','import')),
  applied_at     INTEGER NOT NULL,
  consented_at   INTEGER NOT NULL,
  decided_at     INTEGER,
  decided_by     TEXT,            -- who approved: the board member's Google Workspace email
  updated_at     INTEGER NOT NULL
);

-- Who may open the register beyond the fixed accounts in REGISTER_ADMINS
-- (wrangler.toml): maintained on the register page by whoever already has
-- access. Google Workspace addresses, lower-cased.
CREATE TABLE register_admins (
  email    TEXT    PRIMARY KEY,
  added_by TEXT    NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE INDEX idx_register_status ON register(status);
CREATE UNIQUE INDEX idx_register_email ON register(email COLLATE NOCASE);
CREATE UNIQUE INDEX idx_register_discord ON register(discord_id) WHERE discord_id IS NOT NULL;
