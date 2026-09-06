-- The Mojang account behind a whitelisted name (src/lib/minecraft.ts):
-- looked up when the name is saved, shown as the skin's face so people
-- see it's their account, and handed to the server with the name.
ALTER TABLE minecraft_names ADD COLUMN uuid TEXT;
