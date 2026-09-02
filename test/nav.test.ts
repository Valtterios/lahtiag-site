import { describe, it, expect } from 'vitest';
import { pagePath, navLinks, isCurrentNavLink } from '../src/lib/nav';

describe('pagePath', () => {
  it('maps the home entry to the site root', () => {
    expect(pagePath('home')).toBe('/');
  });

  it('maps any other id to /<id>', () => {
    expect(pagePath('about')).toBe('/about');
  });
});

describe('navLinks', () => {
  it('lists only pages with a navOrder, sorted ascending', () => {
    const links = navLinks([
      { id: 'about', data: { title: 'About', navOrder: 2 } },
      { id: 'privacy', data: { title: 'Privacy' } },
      { id: 'home', data: { title: 'Home', navOrder: 1 } },
    ]);
    expect(links).toEqual([
      { href: '/', label: 'Home' },
      { href: '/about', label: 'About' },
    ]);
  });

  it('returns an empty list when nothing is ordered', () => {
    expect(navLinks([{ id: 'x', data: { title: 'X' } }])).toEqual([]);
  });
});

describe('isCurrentNavLink', () => {
  it('matches an exact match', () => {
    expect(isCurrentNavLink('/about', '/about')).toBe(true);
  });

  it('matches when the pathname has a trailing slash', () => {
    expect(isCurrentNavLink('/about/', '/about')).toBe(true);
  });

  it('matches the root path', () => {
    expect(isCurrentNavLink('/', '/')).toBe(true);
  });

  it('does not match a different link', () => {
    expect(isCurrentNavLink('/about', '/rules')).toBe(false);
  });
});
