# Biome seed scanner

Finds seeds with a lot of a given biome around spawn, using the game's own
world generator, so it is right for whatever version the server jar is.
Chunkbase is closed and cubiomes stopped at 1.21, so this is what we have
for the 26.x drops. Ten seeds a second on auraserver.

The server jar has shipped unobfuscated since 26.x, so the program is
written against the real class names and compiles against the jar plus
the libraries bundled inside it.

## Run (on auraserver, in AMP's Java 25 image)

    mkdir -p /root/biomescan && cd /root/biomescan
    cp <server.jar> server.jar
    unzip -o -q server.jar "META-INF/*" -d bundle     # the inner jar and the libraries
    cp BiomeScan.java run.sh .                        # from this folder
    # edit run.sh if the inner jar's version path changed (bundle/META-INF/versions/<v>/server-<v>.jar)
    docker run --rm --entrypoint /bin/sh -v /root/biomescan:/scan -w /scan -m 6g \
      docker.io/cubecoders/ampbase:java /scan/run.sh minecraft:dappled_forest 1024 32 10 random 6000 42 \
      | grep -o '{.*}' > sweep.jsonl

Arguments: biome id, radius in blocks, grid step, threads, then either a
list of seeds or `random <count> [rng seed]`. One JSON line per seed:
share of the square that is the biome, the biggest connected patch in
km², its centre, and the three commonest biomes. Sort by `patch_km2`.

The first run compiles into `out/`; delete it after swapping the jar.
