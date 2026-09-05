-- Per-event questions ("in-game name", "dietary needs", "shirt size") and
-- the answers people give when they sign up or buy a ticket. Answers are
-- kept per person (Discord id) per event so they survive a voided ticket
-- and a re-purchase; door tickets bought by name without an account keep
-- theirs by ticket id.
CREATE TABLE event_questions (
  id       INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  label    TEXT    NOT NULL,
  kind     TEXT    NOT NULL CHECK (kind IN ('text','choice','checkbox')),
  options  TEXT,                      -- choice: one option per line
  required INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_event_questions_event ON event_questions(event_id);

CREATE TABLE signup_answers (
  question_id INTEGER NOT NULL REFERENCES event_questions(id),
  event_id    INTEGER NOT NULL REFERENCES events(id),
  discord_id  TEXT,
  ticket_id   INTEGER REFERENCES tickets(id),
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_answers_person ON signup_answers(question_id, discord_id) WHERE discord_id IS NOT NULL;
CREATE UNIQUE INDEX idx_answers_ticket ON signup_answers(question_id, ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_answers_event ON signup_answers(event_id);
