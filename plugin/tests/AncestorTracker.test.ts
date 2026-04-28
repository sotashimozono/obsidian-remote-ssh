import { describe, it, expect } from 'vitest';
import { AncestorTracker } from '../src/conflict/AncestorTracker';

describe('AncestorTracker', () => {
  // ─── basic round-trip ─────────────────────────────────────────────────────

  it('returns null for an unknown path', () => {
    const t = new AncestorTracker();
    expect(t.get('not-tracked.md')).toBeNull();
  });

  it('round-trips remember → get with content + mtime', () => {
    const t = new AncestorTracker();
    t.remember('note.md', 'hello world', 1700);
    expect(t.get('note.md')).toEqual({ content: 'hello world', mtime: 1700 });
  });

  it('remembering the same path replaces the previous snapshot', () => {
    const t = new AncestorTracker();
    t.remember('note.md', 'old', 1);
    t.remember('note.md', 'new', 2);
    expect(t.get('note.md')).toEqual({ content: 'new', mtime: 2 });
    expect(t.stats().entries).toBe(1);
  });

  // ─── invalidation / clear ────────────────────────────────────────────────

  it('invalidate drops the entry and frees its bytes', () => {
    const t = new AncestorTracker();
    t.remember('a.md', 'aaa', 1);
    t.remember('b.md', 'bbb', 2);
    expect(t.stats().entries).toBe(2);
    t.invalidate('a.md');
    expect(t.get('a.md')).toBeNull();
    expect(t.stats().entries).toBe(1);
  });

  it('clear empties everything', () => {
    const t = new AncestorTracker();
    t.remember('a.md', 'aaa', 1);
    t.remember('b.md', 'bbb', 2);
    t.clear();
    expect(t.stats()).toEqual({ entries: 0, bytes: 0, maxBytes: AncestorTracker.DEFAULT_MAX_BYTES });
  });

  // ─── byte accounting ─────────────────────────────────────────────────────

  it('counts ASCII as one byte per char', () => {
    const t = new AncestorTracker();
    t.remember('a.md', 'abcde', 1);
    expect(t.stats().bytes).toBe(5);
  });

  it('counts a 4-byte CJK char correctly (3 bytes per BMP char)', () => {
    const t = new AncestorTracker();
    t.remember('jp.md', '日本語', 1); // each char is U+65E5/U+672C/U+8A9E, all BMP → 3 bytes
    expect(t.stats().bytes).toBe(9);
  });

  it('counts an astral-plane (surrogate-pair) emoji as 4 bytes', () => {
    const t = new AncestorTracker();
    t.remember('e.md', '😀', 1); // U+1F600 → surrogate pair, 4 UTF-8 bytes
    expect(t.stats().bytes).toBe(4);
  });

  // ─── LRU eviction ────────────────────────────────────────────────────────

  it('evicts oldest entries when total bytes cross maxBytes', () => {
    // Cap at 100 bytes; each entry is 40 bytes → 2 fit, the 3rd triggers eviction.
    const t = new AncestorTracker(100);
    const payload = 'x'.repeat(40);
    t.remember('first.md', payload, 1);
    t.remember('second.md', payload, 2);
    t.remember('third.md', payload, 3);

    // Eviction shrinks to 90 % of cap = 90 bytes; with 40-byte entries
    // the only outcome below 90 is 1 or 2 entries (40 or 80 bytes).
    // The one we just remembered (third) must survive; "first" should
    // be the dropped one (oldest lastAccessed).
    expect(t.get('third.md')).not.toBeNull();
    expect(t.get('first.md')).toBeNull();
    const after = t.stats();
    expect(after.bytes).toBeLessThanOrEqual(t['maxBytes' as keyof typeof t] as number);
  });

  it('LRU touch on get keeps a hot entry alive across eviction', () => {
    const t = new AncestorTracker(100);
    const payload = 'x'.repeat(40);
    t.remember('cold.md', payload, 1);
    t.remember('hot.md',  payload, 2);
    // Touch 'cold' so it becomes more recent than 'hot'.
    t.get('cold.md');
    // Add a third entry — eviction should now drop 'hot' (oldest by lastAccessed).
    t.remember('newest.md', payload, 3);

    expect(t.get('cold.md')).not.toBeNull();
    expect(t.get('hot.md')).toBeNull();
    expect(t.get('newest.md')).not.toBeNull();
  });

  it('replacing an existing entry adjusts byte accounting (no double-counting)', () => {
    const t = new AncestorTracker();
    t.remember('a.md', 'short', 1);
    expect(t.stats().bytes).toBe(5);
    t.remember('a.md', 'much longer payload', 2);
    expect(t.stats().bytes).toBe('much longer payload'.length);
  });

  it('invalidate of a missing key is a no-op (no negative bytes)', () => {
    const t = new AncestorTracker();
    t.remember('a.md', 'aaa', 1);
    const before = t.stats().bytes;
    t.invalidate('missing.md');
    expect(t.stats().bytes).toBe(before);
  });

  // ─── stats() shape ───────────────────────────────────────────────────────

  it('stats reports the configured maxBytes', () => {
    const t = new AncestorTracker(12345);
    expect(t.stats().maxBytes).toBe(12345);
  });
});
