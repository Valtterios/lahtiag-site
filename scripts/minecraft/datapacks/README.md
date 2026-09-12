# Data packs for the SMP

Copied into `<world>/datapacks/` on the server. A new world needs them
copied in before its first start for anything that changes generation;
`lahtiag-tweaks` only changes spawning, so it can go in any time and
`/reload` picks it up.

- **lahtiag-tweaks**: pillager outposts generate as usual, but their
  spawn rule is empty, so no pillagers spawn at them. Needed when an
  outpost's building is removed: the spawning is tied to the structure's
  record in the chunk, not to its blocks, so the blocks alone don't stop
  it. Patrols are untouched; `/gamerule doPatrolSpawning false` handles
  those.

`min_format`/`max_format` in pack.mcmeta is the data pack format of the
server's version (`version.json` inside the jar, `data_major`); bump it
when the server moves on.
