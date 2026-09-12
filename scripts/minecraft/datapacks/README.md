# Data packs for the SMP

Copied into `<world>/datapacks/` on the server. A new world needs them
copied in before its first start for anything that changes generation;
`lahtiag-tweaks` only changes spawning, so it can go in any time and
`/reload` picks it up.

- **lahtiag-tweaks**: no pillager outposts. The placement set is
  emptied, so none generate in chunks made after the pack is in (put it
  in the world folder before the first start), and the structure's spawn
  rule is emptied too, so an outpost that already exists spawns nobody.
  Patrols elsewhere are untouched; `/gamerule doPatrolSpawning false`
  handles those.

`min_format`/`max_format` in pack.mcmeta is the data pack format of the
server's version (`version.json` inside the jar, `data_major`); bump it
when the server moves on.
