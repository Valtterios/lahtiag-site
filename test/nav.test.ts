import { describe, it, expect } from 'vitest';
import { pagePath, navLinks } from '../src/lib/nav';

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
