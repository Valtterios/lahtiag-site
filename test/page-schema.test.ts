import { describe, it, expect } from 'vitest';
import { pageSchema } from '../src/lib/page-schema';

describe('pageSchema', () => {
  it('accepts a page with only a title', () => {
    const result = pageSchema.safeParse({ title: 'About' });
    expect(result.success).toBe(true);
  });

  it('accepts description and navOrder', () => {
    const result = pageSchema.safeParse({
      title: 'Home',
      description: 'The LahtiAG gaming association',
      navOrder: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.navOrder).toBe(1);
    }
  });

  it('rejects a missing title', () => {
    expect(pageSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(pageSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a non-integer navOrder', () => {
    expect(pageSchema.safeParse({ title: 'x', navOrder: 1.5 }).success).toBe(false);
  });

  it('runs inside the Workers runtime, not Node', () => {
    // workerd identifies itself this way; Node has no navigator.userAgent
    // of this value. This is the proof that the harness is the real thing.
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });
});
