import { describe, it, expect } from 'vitest';
// Vite inlines the file's text at transform time.
import toml from '../wrangler.toml?raw';

// Every server route must be listed in wrangler.toml's `run_worker_first`.
// Cloudflare's asset router answers browser NAVIGATION requests for
// unmatched paths with the 404 page and never invokes the Worker, so a
// route missing from that list works under curl and 404s in a real
// browser — the trap wrangler.toml and OPERATIONS.md both warn about, and
// one nothing caught until /dc hit it.
//
// A test runs inside workerd and cannot open the repo, so Vite inlines
// what this one needs at transform time: the config's text, and every
// page's source (to tell a server route from a prerendered one).

const sources = import.meta.glob('../src/pages/**/*.{astro,ts}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
// A prerendered page is a static asset; the asset router is meant to answer it.
const pages = Object.entries(sources)
  .filter(([, source]) => !/export\s+const\s+prerender\s*=\s*true/.test(source))
  .map(([path]) => path.replace('../src/pages/', ''));

// "events/[id]/bracket.astro" -> "/events/*/bracket"
export function routeOf(file: string): string {
  const path = file
    .replace(/\.(astro|ts)$/, '')
    .replace(/(^|\/)index$/, '')
    .replace(/\[\.\.\.[^\]]+\]/g, '*')
    .replace(/\[[^\]]+\]/g, '*');
  return (`/${path}`.replace(/\/+$/, '') || '/');
}

function patterns(block: string): string[] {
  const list = /run_worker_first\s*=\s*\[([^\]]*)\]/.exec(block);
  return [...(list?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// "/events/*" covers "/events/*/bracket"; "/dc" covers only itself.
export function covers(pattern: string, route: string): boolean {
  return pattern === route || (pattern.endsWith('/*') && route.startsWith(pattern.slice(0, -1)));
}

const blocks = toml.split(/^\[env\.preview\.assets\]/m);
const routes = pages.map(routeOf).filter((r) => r !== '/404');

describe('run_worker_first', () => {
  it('reads the pages and the config', () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(blocks.length).toBe(2); // production, then the preview environment
    expect(patterns(blocks[0]).length).toBeGreaterThan(10);
  });

  it('maps a page file to the path it is served at', () => {
    expect(routeOf('dc.ts')).toBe('/dc');
    expect(routeOf('index.astro')).toBe('/');
    expect(routeOf('events/[id]/bracket.astro')).toBe('/events/*/bracket');
    expect(routeOf('events/index.astro')).toBe('/events');
    expect(covers('/events/*', '/events/*/bracket')).toBe(true);
    expect(covers('/home', '/dc')).toBe(false);
  });

  it('lists every server route, so browsers reach the Worker', () => {
    const production = patterns(blocks[0]);
    expect(routes.filter((route) => !production.some((p) => covers(p, route)))).toEqual([]);
  });

  it('keeps the preview environment in step with production', () => {
    expect([...patterns(blocks[1])].sort()).toEqual([...patterns(blocks[0])].sort());
  });
});
