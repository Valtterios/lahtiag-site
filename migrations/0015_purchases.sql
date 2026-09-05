-- One purchase groups what was paid for together: tickets (possibly for
-- several events, possibly for friends by name) and shop items. Tickets
-- point at their purchase; goods live in purchase_items.
CREATE TABLE purchases (
  id                    TEXT    PRIMARY KEY,
  discord_id            TEXT,
  buyer_name            TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('pending','paid','refunded','void')),
  total_cents           INTEGER NOT NULL,
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT,
  checkout_url          TEXT,
  created_at            INTEGER NOT NULL,
  paid_at               INTEGER
);
CREATE INDEX idx_purchases_buyer ON purchases(discord_id);
CREATE INDEX idx_purchases_session ON purchases(stripe_session_id);
CREATE INDEX idx_purchases_intent ON purchases(stripe_payment_intent);

CREATE TABLE products (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL,
  description        TEXT    NOT NULL DEFAULT '',
  price_cents        INTEGER NOT NULL,
  member_price_cents INTEGER,
  stock              INTEGER,
  active             INTEGER NOT NULL DEFAULT 1,
  sort               INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

CREATE TABLE purchase_items (
  id           INTEGER PRIMARY KEY,
  purchase_id  TEXT    NOT NULL REFERENCES purchases(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  name         TEXT    NOT NULL,
  quantity     INTEGER NOT NULL,
  unit_cents   INTEGER NOT NULL,
  delivered_at INTEGER,
  delivered_by TEXT
);
CREATE INDEX idx_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_items_product ON purchase_items(product_id);

ALTER TABLE tickets ADD COLUMN bought_by TEXT;
ALTER TABLE tickets ADD COLUMN purchase_id TEXT;
CREATE INDEX idx_tickets_purchase ON tickets(purchase_id);
CREATE INDEX idx_tickets_buyer ON tickets(bought_by);
