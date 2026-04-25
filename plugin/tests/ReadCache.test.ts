import { describe, it, expect, beforeEach } from 'vitest';
import { ReadCache } from '../src/cache/ReadCache';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('ReadCache', () => {
  let cache: ReadCache;

  beforeEach(() => {
    cache = new ReadCache({ maxBytes: 1024 });
  });

  it('returns null on miss and bumps the misses counter', () => {
    expect(cache.get('foo.md')).toBeNull();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it('round-trips data and mtime through put/get', () => {
    cache.put('foo.md', buf('hello'), 1000);
    const got = cache.get('foo.md');
    expect(got?.data.toString('utf8')).toBe('hello');
    expect(got?.mtime).toBe(1000);
    expect(got?.byteSize).toBe(5);
    expect(cache.stats().hits).toBe(1);
  });

  it('peek does not change LRU order', () => {
    const lru = new ReadCache({ maxBytes: 10 });
    lru.put('a', Buffer.alloc(4), 1);
    lru.put('b', Buffer.alloc(4), 1); // 8 bytes, fits
    lru.peek('a'); // peek "a" but do not bump
    lru.put('c', Buffer.alloc(4), 1); // 12 bytes → evict oldest "a"
    expect(lru.has('a')).toBe(false); // evicted because peek did not refresh order
    expect(lru.has('b')).toBe(true);
    expect(lru.has('c')).toBe(true);
  });

  it('get() bumps an entry to most-recently-used', () => {
    const lru = new ReadCache({ maxBytes: 10 });
    lru.put('a', Buffer.alloc(4), 1);
    lru.put('b', Buffer.alloc(4), 1);
    lru.get('a'); // refresh "a" → "b" is now LRU
    lru.put('c', Buffer.alloc(4), 1); // evicts "b"
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
  });

  it('put() overwrites the existing entry and adjusts byte accounting', () => {
    cache.put('foo', buf('short'), 1);
    cache.put('foo', buf('a much longer payload'), 2);
    const entry = cache.peek('foo');
    expect(entry?.mtime).toBe(2);
    expect(entry?.data.toString('utf8')).toBe('a much longer payload');
    expect(cache.stats().bytes).toBe(entry!.byteSize);
  });

  it('invalidate removes the entry and refunds its bytes', () => {
    cache.put('foo', buf('hello'), 1);
    cache.invalidate('foo');
    expect(cache.has('foo')).toBe(false);
    expect(cache.stats().bytes).toBe(0);
  });

  it('invalidate is a no-op for an unknown key', () => {
    cache.put('foo', buf('hello'), 1);
    cache.invalidate('bar');
    expect(cache.has('foo')).toBe(true);
    expect(cache.stats().bytes).toBe(5);
  });

  it('invalidatePrefix removes the directory and its descendants', () => {
    cache.put('docs/a.md', buf('a'), 1);
    cache.put('docs/sub/b.md', buf('b'), 1);
    cache.put('docs', buf('dir-marker'), 1);
    cache.put('other.md', buf('o'), 1);
    const removed = cache.invalidatePrefix('docs');
    expect(removed).toBe(3);
    expect(cache.has('docs/a.md')).toBe(false);
    expect(cache.has('docs/sub/b.md')).toBe(false);
    expect(cache.has('docs')).toBe(false);
    expect(cache.has('other.md')).toBe(true);
  });

  it('invalidatePrefix does not match unrelated paths that share a prefix', () => {
    cache.put('docs', buf('a'), 1);
    cache.put('docs2', buf('b'), 1);
    cache.invalidatePrefix('docs');
    expect(cache.has('docs')).toBe(false);
    expect(cache.has('docs2')).toBe(true);
  });

  it('evicts least-recently-used entries to stay under the byte budget', () => {
    const small = new ReadCache({ maxBytes: 16 });
    small.put('a', Buffer.alloc(8), 1); // 8 bytes
    small.put('b', Buffer.alloc(8), 1); // 16 bytes total
    small.put('c', Buffer.alloc(8), 1); // would be 24 → evict "a"
    expect(small.has('a')).toBe(false);
    expect(small.has('b')).toBe(true);
    expect(small.has('c')).toBe(true);
    expect(small.stats().evictions).toBe(1);
    expect(small.stats().bytes).toBe(16);
  });

  it('evicts multiple entries when a single put busts the budget by a lot', () => {
    const small = new ReadCache({ maxBytes: 16 });
    small.put('a', Buffer.alloc(4), 1);
    small.put('b', Buffer.alloc(4), 1);
    small.put('c', Buffer.alloc(4), 1);
    small.put('big', Buffer.alloc(16), 1); // forces eviction of a, b, c
    expect(small.has('a')).toBe(false);
    expect(small.has('b')).toBe(false);
    expect(small.has('c')).toBe(false);
    expect(small.has('big')).toBe(true);
    expect(small.stats().bytes).toBe(16);
  });

  it('clear empties the cache and resets byte accounting', () => {
    cache.put('a', buf('hi'), 1);
    cache.put('b', buf('there'), 1);
    cache.clear();
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(false);
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().bytes).toBe(0);
  });
});
