// Astro re-exports its own Zod build at `astro/zod`; using it here keeps the
// schema on the same Zod instance that `defineCollection` validates with.
import { z } from 'astro/zod';

export const pageSchema = z.object({
  // Shown in the <title>, the <h1> and the navigation label.
  title: z.string().min(1),
  // Optional <meta name="description">.
  description: z.string().optional(),
  // Pages with a navOrder appear in the header nav, sorted ascending.
  // Pages without one are reachable by URL but not listed.
  navOrder: z.number().int().optional(),
});

export type PageFrontmatter = z.infer<typeof pageSchema>;
