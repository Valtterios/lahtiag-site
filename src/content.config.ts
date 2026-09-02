import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { pageSchema } from './lib/page-schema';

// Every .md file under src/content/pages becomes one entry whose id is the
// filename without extension: about.md -> 'about' -> served at /about.
const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: pageSchema,
});

export const collections = { pages };
