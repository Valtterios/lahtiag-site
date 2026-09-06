-- Which servers a whitelisted name is for (src/lib/minecraft.ts SERVERS):
-- a comma-separated list of slugs. Every name is for every server unless
-- narrowed when it is saved.
ALTER TABLE minecraft_names ADD COLUMN servers TEXT NOT NULL DEFAULT 'smp,gtnh';
