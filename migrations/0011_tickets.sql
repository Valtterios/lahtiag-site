-- Tickets (plan: docs/superpowers/plans/2026-09-05-tickets.md).
--
-- Events can be members-only or keep seats for members; ticketed events
-- sell ticket types (a price of 0 is a free ticket). A ticket's `code` is
-- what the QR carries and what the door scans. One live ticket per
-- Discord account per event; walk-ins bought by name have no account.
-- Tap to Pay payments taken in the Stripe Dashboard app carry no
-- metadata, so they land in door_payments until attached at the door.

ALTER TABLE events ADD COLUMN members_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN member_slots INTEGER;

CREATE TABLE ticket_types (
  id                 INTEGER PRIMARY KEY,
  event_id           INTEGER NOT NULL REFERENCES events(id),
  name               TEXT    NOT NULL,
  price_cents        INTEGER NOT NULL,
  member_price_cents INTEGER,
  members_only       INTEGER NOT NULL DEFAULT 0,
  quantity           INTEGER,
  sales_close_at     INTEGER,
  sort               INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_ticket_types_event ON ticket_types(event_id);

CREATE TABLE tickets (
  id                    INTEGER PRIMARY KEY,
  event_id              INTEGER NOT NULL REFERENCES events(id),
  ticket_type_id        INTEGER NOT NULL REFERENCES ticket_types(id),
  discord_id            TEXT,
  holder_name           TEXT    NOT NULL,
  code                  TEXT    NOT NULL UNIQUE,
  amount_cents          INTEGER NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('pending','paid','refunded','void')),
  source                TEXT    NOT NULL CHECK (source IN ('online','door','comp')),
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT,
  created_at            INTEGER NOT NULL,
  paid_at               INTEGER,
  checked_in_at         INTEGER,
  checked_in_by         TEXT
);
CREATE INDEX idx_tickets_event ON tickets(event_id);
CREATE INDEX idx_tickets_session ON tickets(stripe_session_id);
CREATE UNIQUE INDEX idx_tickets_holder ON tickets(event_id, discord_id)
  WHERE discord_id IS NOT NULL AND status IN ('pending', 'paid');

CREATE TABLE door_payments (
  stripe_payment_intent TEXT    PRIMARY KEY,
  amount_cents          INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  ticket_id             INTEGER REFERENCES tickets(id)
);
