-- Tournament-style team signups. An event with team_size set is
-- team-based: members form ad-hoc teams for that event (distinct from the
-- standing `teams` squads), capacity counts TEAMS not people, and a signup
-- may point at the event team its member joined. A signup with no
-- event_team_id on a team event is a free agent looking for a team.

ALTER TABLE events ADD COLUMN team_size INTEGER;

-- Free-text organizer names ("LahtiAG, Kapital"), comma-separated. Replaces
-- the team_id link as "whose event is this": organizers are often external
-- partners, not standing squads. team_id stays in the schema but nothing
-- writes it any more.
ALTER TABLE events ADD COLUMN organizers TEXT;

CREATE TABLE event_teams (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  name       TEXT    NOT NULL,
  created_by TEXT    NOT NULL REFERENCES members(discord_id),
  created_at INTEGER NOT NULL
);

ALTER TABLE signups ADD COLUMN event_team_id INTEGER REFERENCES event_teams(id);

CREATE INDEX idx_event_teams_event ON event_teams(event_id);
CREATE UNIQUE INDEX idx_event_teams_name ON event_teams(event_id, name COLLATE NOCASE);
