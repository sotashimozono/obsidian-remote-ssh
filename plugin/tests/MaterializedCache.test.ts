import { describe, it, expect, vi } from 'vitest';
import { MaterializedCache, type MaterializedStat } from '../src/adapter/MaterializedCache';
import { syncHttpGetBinary, totalFromContentRange } from '../src/util/syncHttpGet';

/**
 * In-memory disk. `mtimeMs` advances on every write, so a rewrite is
 * distinguishable from the copy that was already there — which is
 * exactly how the real ledger tells "our copy" from "somebody edited
 * it".
 */
function fakeDisk() {
  const files = new Map<string, { data: Buffer; stat: MaterializedStat }>();
  let clock = 1000;
  return {
    files,
    deps: {
      absOf: (rel: string) => `/root/${rel}`,
      writeFile: (abs: string, data: Buffer): MaterializedStat => {
        const stat = { size: data.byteLength, mtimeMs: ++clock };
        files.set(abs, { data, stat });
        return stat;
      },
      statFile: (abs: string) => files.get(abs)?.stat ?? null,
      deleteFile: (abs: string) => { files.delete(abs); },
      budgetBytes: 100,
      maxFileBytes: 50,
    },
    /** Simulate someone else editing a file we materialised. */
    tamper: (abs: string, body: string) => {
      files.set(abs, { data: Buffer.from(body), stat: { size: body.length, mtimeMs: ++clock } });
    },
  };
}

describe('MaterializedCache', () => {
  it('writes a requested file and reports it as present', () => {
    const d = fakeDisk();
    const c = new MaterializedCache(d.deps);
    expect(c.put('note.md', Buffer.from('hello'))).toBe(true);
    expect(d.files.get('/root/note.md')?.data.toString()).toBe('hello');
    expect(c.has('note.md')).toBe(true);
    expect(c.bytes()).toBe(5);
  });

  it('refuses a file over the per-file ceiling without writing anything', () => {
    const d = fakeDisk();
    const c = new MaterializedCache(d.deps);
    expect(c.tooBig(51)).toBe(true);
    expect(c.put('big.bin', Buffer.alloc(51))).toBe(false);
    expect(d.files.size, 'an over-limit file was written to disk anyway').toBe(0);
  });

  it('never exceeds the budget — the least recently used copy goes first', () => {
    const d = fakeDisk();
    const c = new MaterializedCache(d.deps);
    c.put('a.md', Buffer.alloc(40));
    c.put('b.md', Buffer.alloc(40));
    c.has('a.md');                     // a is now the most recently used
    c.put('c.md', Buffer.alloc(40));   // 120 > 100 budget

    expect(c.bytes()).toBeLessThanOrEqual(100);
    expect(d.files.has('/root/b.md'), 'the LRU victim is still on disk').toBe(false);
    expect(d.files.has('/root/a.md')).toBe(true);
    expect(d.files.has('/root/c.md')).toBe(true);
  });

  it('does NOT evict a copy somebody edited — that would destroy an unpushed edit', () => {
    const d = fakeDisk();
    const c = new MaterializedCache(d.deps);
    c.put('a.md', Buffer.alloc(40));
    d.tamper('/root/a.md', 'x'.repeat(40));   // same size, new mtime: a local edit
    c.put('b.md', Buffer.alloc(40));
    c.put('c.md', Buffer.alloc(40));

    expect(d.files.has('/root/a.md'), 'an edited file was evicted').toBe(true);
    expect(c.isMirroredCopy('a.md', d.deps.statFile('/root/a.md')!)).toBe(false);
  });

  it('stops calling an edited copy its own', () => {
    const d = fakeDisk();
    const c = new MaterializedCache(d.deps);
    c.put('note.md', Buffer.from('remote body'));
    const asWritten = d.deps.statFile('/root/note.md')!;
    expect(c.isMirroredCopy('note.md', asWritten)).toBe(true);

    d.tamper('/root/note.md', 'edited by a plugin');
    const now = d.deps.statFile('/root/note.md')!;
    expect(
      c.isMirroredCopy('note.md', now),
      'an edited file still looked like our copy — the write-back would drop it',
    ).toBe(false);
    expect(c.has('note.md')).toBe(false);
  });

  it('clear() removes our untouched copies and leaves edited ones behind', () => {
    const d = fakeDisk();
    const c = new MaterializedCache(d.deps);
    c.put('clean.md', Buffer.from('remote'));
    c.put('edited.md', Buffer.from('remote'));
    d.tamper('/root/edited.md', 'local changes');

    c.clear();
    expect(d.files.has('/root/clean.md')).toBe(false);
    expect(d.files.has('/root/edited.md'), 'clear() deleted an edited file').toBe(true);
    expect(c.bytes()).toBe(0);
  });

  it('a zero budget disables it entirely', () => {
    const d = fakeDisk();
    const c = new MaterializedCache({ ...d.deps, budgetBytes: 0 });
    expect(c.disabled()).toBe(true);
    expect(c.put('note.md', Buffer.from('x'))).toBe(false);
    expect(d.files.size).toBe(0);
  });

  it('forgets a file that vanished from disk', () => {
    const d = fakeDisk();
    const c = new MaterializedCache(d.deps);
    c.put('note.md', Buffer.from('body'));
    d.files.delete('/root/note.md');
    expect(c.has('note.md')).toBe(false);
    expect(c.bytes()).toBe(0);
  });
});

describe('syncHttpGetBinary', () => {
  const stub = (over: Record<string, unknown>) => ({
    open: vi.fn(), setRequestHeader: vi.fn(), overrideMimeType: vi.fn(), send: vi.fn(),
    getResponseHeader: () => null,
    status: 200, responseText: '',
    ...over,
  });

  const withXhr = <T>(impl: object, run: () => T): T => {
    const g = globalThis as { XMLHttpRequest?: unknown };
    const saved = g.XMLHttpRequest;
    g.XMLHttpRequest = function XHR() { return impl; } as unknown;
    try { return run(); } finally { g.XMLHttpRequest = saved; }
  };

  it('maps the response back to raw bytes', () => {
    const r = withXhr(stub({ status: 200, responseText: 'H\u00ff\u0000' }), () =>
      syncHttpGetBinary('http://127.0.0.1:1/r/tok?p=a', 1024));
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && [...r.bytes]).toEqual([0x48, 0xff, 0x00]);
  });

  it('refuses a file whose Content-Range says it is over the limit', () => {
    const r = withXhr(
      stub({ status: 206, responseText: 'partial', getResponseHeader: () => 'bytes 0-6/999999' }),
      () => syncHttpGetBinary('http://127.0.0.1:1/r/tok?p=a', 8),
    );
    expect(r).toEqual({ kind: 'too-large', totalSize: 999999 });
  });

  it('reports unavailable instead of throwing when there is no vehicle', () => {
    const g = globalThis as { XMLHttpRequest?: unknown };
    const saved = g.XMLHttpRequest;
    delete g.XMLHttpRequest;
    try {
      expect(syncHttpGetBinary('http://127.0.0.1:1/r/tok?p=a', 8).kind).toBe('unavailable');
    } finally {
      g.XMLHttpRequest = saved;
    }
  });

  it('parses the total out of a Content-Range header', () => {
    expect(totalFromContentRange('bytes 0-1023/4096')).toBe(4096);
    expect(totalFromContentRange('bytes 0-1023/*')).toBeNull();
    expect(totalFromContentRange(null)).toBeNull();
  });
});
