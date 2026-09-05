-- Small board-editable settings, so things like which Discord roles the
-- register mirrors can be changed on the register page instead of in
-- wrangler.toml. Keys are fixed strings in code (src/lib/db.ts).
CREATE TABLE settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
