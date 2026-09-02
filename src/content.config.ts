import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { pageSchema } from './lib/page-schema';

// Every .md file directly under src/content/pages becomes one entry whose id
// is the filename without extension: about.md -> 'about' -> served at
// /about. The pattern is intentionally flat (no **): src/pages/[id].astro is
// a single-segment route, so a nested file (e.g. rules/coc.md, id
// 'rules/coc') would break the build with "Missing parameter: id". Pages
// must live directly in src/content/pages, not in subdirectories.
const pages = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/pages' }),
  schema: pageSchema,
});

export const collections = { pages };
