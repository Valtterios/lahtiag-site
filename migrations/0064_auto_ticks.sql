-- Ticks the bot gives by itself (src/lib/auto-ticks.ts). A kind with an
-- auto_source is paid from what the site already counts: one tick per
-- auto_step minutes on the Minecraft servers or in voice, per auto_step
-- messages, or one per event attended (the step is moot there). The
-- hourly job gives what is due, tells the general channel, and the caps
-- and the pass levels then treat the tick like any other. Board-given
-- kinds have no source and are untouched by this.
ALTER TABLE tick_kinds ADD COLUMN auto_source TEXT CHECK (auto_source IN ('minecraft', 'voice', 'messages', 'events'));
ALTER TABLE tick_kinds ADD COLUMN auto_step INTEGER NOT NULL DEFAULT 0;
