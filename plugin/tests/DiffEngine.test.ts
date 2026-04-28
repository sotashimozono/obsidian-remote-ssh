import { describe, it, expect } from 'vitest';
import { diffLines, type DiffChunk } from '../src/conflict/DiffEngine';

/**
 * Reconstruct the `a` and `b` operands from a diff so we can assert
 * the diff is at least lossless. Used in addition to chunk-shape
 * assertions to catch backtrack bugs that produce a "valid-looking"
 * diff that doesn't actually round-trip.
 */
function reconstruct(diff: DiffChunk[]): { a: string[]; b: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  for (const c of diff) {
    if (c.kind === 'eq') { a.push(...c.lines); b.push(...c.lines); }
    else if (c.kind === 'del') { a.push(...c.lines); }
    else /* add */ { b.push(...c.lines); }
  }
  return { a, b };
}

function chunks(diff: DiffChunk[]): Array<[DiffChunk['kind'], string[]]> {
  return diff.map(c => [c.kind, c.lines]);
}

describe('diffLines', () => {
  // ─── boundary: empty inputs ─────────────────────────────────────────────

  it('returns no chunks when both sides are empty', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('emits one add chunk when the left side is empty', () => {
    expect(chunks(diffLines('', 'one\ntwo'))).toEqual([
      ['add', ['one', 'two']],
    ]);
  });

  it('emits one del chunk when the right side is empty', () => {
    expect(chunks(diffLines('one\ntwo', ''))).toEqual([
      ['del', ['one', 'two']],
    ]);
  });

  // ─── identity ───────────────────────────────────────────────────────────

  it('emits a single eq chunk when both sides are identical', () => {
    const text = 'alpha\nbeta\ngamma';
    expect(chunks(diffLines(text, text))).toEqual([
      ['eq', ['alpha', 'beta', 'gamma']],
    ]);
  });

  // ─── basic edits ────────────────────────────────────────────────────────

  it('detects a pure addition in the middle', () => {
    const a = 'alpha\ngamma';
    const b = 'alpha\nbeta\ngamma';
    expect(chunks(diffLines(a, b))).toEqual([
      ['eq',  ['alpha']],
      ['add', ['beta']],
      ['eq',  ['gamma']],
    ]);
  });

  it('detects a pure deletion in the middle', () => {
    const a = 'alpha\nbeta\ngamma';
    const b = 'alpha\ngamma';
    expect(chunks(diffLines(a, b))).toEqual([
      ['eq',  ['alpha']],
      ['del', ['beta']],
      ['eq',  ['gamma']],
    ]);
  });

  it('represents a line replacement as adjacent del + add', () => {
    const a = 'alpha\nbeta\ngamma';
    const b = 'alpha\nBETA\ngamma';
    const got = chunks(diffLines(a, b));
    // Order between del and add at the same site isn't specified
    // beyond "eq stays in place"; assert as a multiset of the pair.
    expect(got[0]).toEqual(['eq', ['alpha']]);
    expect(got[got.length - 1]).toEqual(['eq', ['gamma']]);
    const middle = got.slice(1, -1).map(c => `${c[0]}:${(c[1] as string[]).join('|')}`).sort();
    expect(middle).toEqual(['add:BETA', 'del:beta']);
  });

  it('groups consecutive same-kind ops into a single chunk', () => {
    const a = 'a\nb\nc\nd';
    const b = 'a\nx\ny\nd';
    // Expected: eq[a], del[b,c], add[x,y], eq[d] (or add/del in other order).
    const got = diffLines(a, b);
    // No two adjacent chunks should share a kind.
    for (let i = 1; i < got.length; i++) {
      expect(got[i].kind).not.toBe(got[i - 1].kind);
    }
  });

  // ─── content-preservation invariants ────────────────────────────────────

  it('reconstructs both inputs from the diff (trivial case)', () => {
    const a = 'hello';
    const b = 'world';
    const r = reconstruct(diffLines(a, b));
    expect(r.a.join('\n')).toBe(a);
    expect(r.b.join('\n')).toBe(b);
  });

  it('reconstructs both inputs from a non-trivial mixed diff', () => {
    const a = 'one\ntwo\nthree\nfour\nfive';
    const b = 'one\nTWO\nthree\nfive\nsix';
    const r = reconstruct(diffLines(a, b));
    expect(r.a.join('\n')).toBe(a);
    expect(r.b.join('\n')).toBe(b);
  });

  it('reconstructs both inputs when one side is much longer', () => {
    const a = 'short';
    const b = 'much\nmuch\nlonger\nright\nhere';
    const r = reconstruct(diffLines(a, b));
    expect(r.a.join('\n')).toBe(a);
    expect(r.b.join('\n')).toBe(b);
  });

  // ─── perf sanity ────────────────────────────────────────────────────────

  it('handles a 500-line file diff under 100ms', () => {
    const a = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const b = Array.from({ length: 500 }, (_, i) => i % 7 === 0 ? `LINE ${i}` : `line ${i}`).join('\n');
    const start = Date.now();
    const got = diffLines(a, b);
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(100);
    expect(got.length).toBeGreaterThan(0);
    const r = reconstruct(got);
    expect(r.a.join('\n')).toBe(a);
    expect(r.b.join('\n')).toBe(b);
  });
});
