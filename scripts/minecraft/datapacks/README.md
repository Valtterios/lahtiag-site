# Data packs for the SMP

Copied into `<world>/datapacks/` on the server. A new world needs them
copied in before its first start for anything that changes generation;
`lahtiag-tweaks` only changes spawning, so it can go in any time and
`/reload` picks it up.

- **lahtiag-tweaks**: pillager outposts generate as usual but their spawn
  rule is empty, so no pillagers spawn at them (patrols elsewhere are
  untouched; `/gamerule doPatrolSpawning false` handles those). To drop
  outposts entirely instead, override
  `data/minecraft/worldgen/structure_set/pillager_outposts.json` with an
  empty `structures` list before the world is generated.

`min_format`/`max_format` in pack.mcmeta is the data pack format of the
server's version (`version.json` inside the jar, `data_major`); bump it
when the server moves on.
