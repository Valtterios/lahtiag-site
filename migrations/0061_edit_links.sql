-- A private link for somebody with no Discord account to put their own
-- entry right: the board sends one with a correction, and it is the only
-- way in that does not go through an account. Only a hash is kept, so a
-- copy of this table is not a set of working links; each dies on its own
-- after a fortnight, when the board asks again, or when the application
-- is decided.
CREATE TABLE register_edit_links (
  token_hash  TEXT PRIMARY KEY,     -- sha-256 of the token in the link
  register_id INTEGER NOT NULL REFERENCES register(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  created_by  TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE INDEX idx_register_edit_links_entry ON register_edit_links(register_id);
