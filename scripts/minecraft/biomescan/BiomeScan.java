// Seed scanner driven by the game's own world generator: boots the
// vanilla registries once and asks the overworld biome source for the
// biome at a grid of points around spawn, for many seeds in parallel.
// Reports, per seed, the share of the square that is the wanted biome
// and the biggest connected patch. Runs against the unobfuscated server
// jar and its bundled libraries on the classpath; swap the jar for the
// next drop and it keeps working.
//
//   java -cp <jars> BiomeScan minecraft:dappled_forest <radius> <step> <threads> seed [seed ...]
//   java -cp <jars> BiomeScan minecraft:dappled_forest <radius> <step> <threads> random <count> [start]
import net.minecraft.SharedConstants;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderGetter;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.BiomeResolver;
import net.minecraft.world.level.biome.MultiNoiseBiomeSource;
import net.minecraft.world.level.biome.MultiNoiseBiomeSourceParameterList;
import net.minecraft.world.level.biome.MultiNoiseBiomeSourceParameterLists;
import net.minecraft.world.level.levelgen.NoiseGeneratorSettings;
import net.minecraft.world.level.levelgen.RandomState;
import net.minecraft.world.level.levelgen.densityfunction.SamplerContext;
import net.minecraft.world.level.levelgen.synth.NormalNoise;

import java.util.*;
import java.util.concurrent.*;

public class BiomeScan {
  public static void main(String[] args) throws Exception {
    String wanted = args[0];
    int radius = Integer.parseInt(args[1]);
    int step = Integer.parseInt(args[2]);
    int threads = Integer.parseInt(args[3]);
    List<Long> seeds = new ArrayList<>();
    if (args[4].equals("random")) {
      int n = Integer.parseInt(args[5]);
      Random r = new Random(args.length > 6 ? Long.parseLong(args[6]) : System.nanoTime());
      for (int i = 0; i < n; i++) seeds.add(r.nextLong());
    } else {
      for (int i = 4; i < args.length; i++) seeds.add(Long.parseLong(args[i]));
    }

    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    HolderLookup.Provider reg = VanillaRegistries.createWorldLookup();
    HolderGetter<NormalNoise> noises = reg.lookupOrThrow(Registries.NOISE);
    NoiseGeneratorSettings settings = reg.lookupOrThrow(Registries.NOISE_SETTINGS).getOrThrow(NoiseGeneratorSettings.OVERWORLD).value();
    Holder<MultiNoiseBiomeSourceParameterList> preset = reg.lookupOrThrow(Registries.MULTI_NOISE_BIOME_SOURCE_PARAMETER_LIST).getOrThrow(MultiNoiseBiomeSourceParameterLists.OVERWORLD);
    MultiNoiseBiomeSource source = MultiNoiseBiomeSource.createFromPreset(preset);

    int n = 2 * radius / step + 1;
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    List<Future<String>> results = new ArrayList<>();
    for (long seed : seeds) {
      results.add(pool.submit(() -> {
        RandomState rs = RandomState.create(noises, seed, settings);
        BiomeResolver res = source.createResolver(rs.createClimateSampler(SamplerContext.EMPTY_UNCACHED));
        boolean[][] hit = new boolean[n][n];
        int hits = 0;
        Map<String, Integer> counts = new HashMap<>();
        for (int i = 0; i < n; i++) {
          for (int j = 0; j < n; j++) {
            int x = -radius + i * step, z = -radius + j * step;
            Holder<Biome> b = res.getNoiseBiome(x >> 2, 64 >> 2, z >> 2);
            String key = b.unwrapKey().map(k -> k.identifier().toString()).orElse("?");
            counts.merge(key, 1, Integer::sum);
            if (key.equals(wanted)) { hit[i][j] = true; hits++; }
          }
        }
        // biggest 4-connected patch
        boolean[][] seen = new boolean[n][n];
        int best = 0; long bx = 0, bz = 0;
        for (int i = 0; i < n; i++) for (int j = 0; j < n; j++) {
          if (!hit[i][j] || seen[i][j]) continue;
          Deque<int[]> stack = new ArrayDeque<>(); stack.push(new int[]{i, j});
          int size = 0; long sx = 0, sz = 0;
          while (!stack.isEmpty()) {
            int[] c = stack.pop();
            int ci = c[0], cj = c[1];
            if (ci < 0 || cj < 0 || ci >= n || cj >= n || seen[ci][cj] || !hit[ci][cj]) continue;
            seen[ci][cj] = true; size++; sx += -radius + ci * step; sz += -radius + cj * step;
            stack.push(new int[]{ci + 1, cj}); stack.push(new int[]{ci - 1, cj}); stack.push(new int[]{ci, cj + 1}); stack.push(new int[]{ci, cj - 1});
          }
          if (size > best) { best = size; bx = sx / size; bz = sz / size; }
        }
        double cell = (double) step * step / 1e6;
        String top = counts.entrySet().stream().sorted((a, b) -> b.getValue() - a.getValue()).limit(3)
            .map(e -> e.getKey().replace("minecraft:", "") + " " + Math.round(100.0 * e.getValue() / (n * n)) + "%").reduce((a, b) -> a + ", " + b).orElse("");
        return String.format(Locale.ROOT, "{\"seed\": %d, \"share\": %.3f, \"patch_km2\": %.2f, \"patch_centre\": [%d, %d], \"top\": \"%s\"}",
            seed, (double) hits / (n * n), best * cell, bx, bz, top);
      }));
    }
    for (Future<String> f : results) System.out.println(f.get());
    pool.shutdown();
  }
}
