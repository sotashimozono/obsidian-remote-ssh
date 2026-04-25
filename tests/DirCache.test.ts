import { describe, it, expect } from 'vitest';
import { DirCache } from '../src/cache/DirCache';
import type { RemoteEntry } from '../src/types';

const e = (name: string, isDirectory = false): RemoteEntry => ({
  name,
  isDirectory,
  isFile: !isDirectory,
  isSymbolicLink: false,
  mtime: 0,
  size: 0,
});

describe('DirCache', () => {
  it('returns null when the path was never put', () => {
    const cache = new DirCache();
    expect(cache.get('docs')).toBeNull();
  });

  it('returns the cached entries within TTL', () => {
    let now = 1000;
    const cache = new DirCache({ ttlMs: 100, now: () => now });
    cache.put('docs', [e('a.md'), e('b.md')]);
    now = 1099; // still within TTL
    expect(cache.get('docs')?.length).toBe(2);
  });

  it('returns null and drops the entry once TTL expires', () => {
    let now = 1000;
    const cache = new DirCache({ ttlMs: 100, now: () => now });
    cache.put('docs', [e('a.md')]);
    now = 1100; // exactly at TTL boundary; treat as expired
    expect(cache.get('docs')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('put refreshes the TTL when re-cached', () => {
    let now = 1000;
    const cache = new DirCache({ ttlMs: 100, now: () => now });
    cache.put('docs', [e('a.md')]);
    now = 1090;
    cache.put('docs', [e('a.md'), e('b.md')]); // refresh
    now = 1180; // would have expired against the original
    expect(cache.get('docs')?.length).toBe(2);
  });

  it('invalidate removes a single path', () => {
    const cache = new DirCache();
    cache.put('docs', [e('a.md')]);
    cache.invalidate('docs');
    expect(cache.get('docs')).toBeNull();
  });

  it('invalidatePrefix drops the dir and its descendants', () => {
    const cache = new DirCache();
    cache.put('docs', [e('a.md')]);
    cache.put('docs/sub', [e('b.md')]);
    cache.put('docs/sub/deep', [e('c.md')]);
    cache.put('other', [e('x.md')]);
    const removed = cache.invalidatePrefix('docs');
    expect(removed).toBe(3);
    expect(cache.get('docs')).toBeNull();
    expect(cache.get('docs/sub')).toBeNull();
    expect(cache.get('docs/sub/deep')).toBeNull();
    expect(cache.get('other')).not.toBeNull();
  });

  it('invalidatePrefix does not match unrelated keys with shared prefix', () => {
    const cache = new DirCache();
    cache.put('docs', [e('a.md')]);
    cache.put('docs2', [e('b.md')]);
    cache.invalidatePrefix('docs');
    expect(cache.get('docs')).toBeNull();
    expect(cache.get('docs2')).not.toBeNull();
  });

  it('clear empties the cache', () => {
    const cache = new DirCache();
    cache.put('a', [e('x')]);
    cache.put('b', [e('y')]);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
