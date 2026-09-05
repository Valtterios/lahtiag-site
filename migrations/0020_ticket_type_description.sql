-- A line under each ticket type: what it includes.
ALTER TABLE ticket_types ADD COLUMN description TEXT NOT NULL DEFAULT '';
