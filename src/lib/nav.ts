// Shape shared by content-collection entries and by tests. A collection
// entry from `getCollection('pages')` satisfies this structurally.
export interface NavSource {
  id: string;
  data: { title: string; navOrder?: number };
}

export interface NavLink {
  href: string;
  label: string;
}

// The entry named `home` is the site root; every other entry lives at /<id>.
export function pagePath(id: string): string {
  return id === 'home' ? '/' : `/${id}`;
}

// Whether href is the current nav item for a request at pathname. Astro's
// Astro.url.pathname may carry a trailing slash (or be exactly "/" for the
// root); links from pagePath() never do except for "/" itself, so a bare
// trailing-slash strip (falling back to "/" when that empties the string)
// is enough to compare them.
export function isCurrentNavLink(pathname: string, href: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return normalized === href;
}

export function navLinks(entries: NavSource[]): NavLink[] {
  return entries
    .filter((entry) => typeof entry.data.navOrder === 'number')
    .sort((a, b) => (a.data.navOrder ?? 0) - (b.data.navOrder ?? 0))
    .map((entry) => ({ href: pagePath(entry.id), label: entry.data.title }));
}
