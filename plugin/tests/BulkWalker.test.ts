import { describe, it, expect, vi } from 'vitest';
import { BulkWalker, type AdapterListSlice, type RpcConnectionSlice } from '../src/vault/BulkWalker';
import type { WalkResult } from '../src/proto/types';

/**
 * Build a fake adapter whose `list(p)` returns a stubbed
 * `{files, folders}` per path. Unknown paths reply empty.
 */
function makeAdapter(map: Record<string, { files?: string[]; folders?: string[] }>): AdapterListSlice {
  return {
    async list(p: string) {
      const entry = map[p];
      return {
        files:   entry?.files ?? [],
        folders: entry?.folders ?? [],
      };
    },
  };
}

/**
 * Build a fake RPC connection that advertises `capabilities` and
 * answers `fs.walk` from `walkResult`. Either `walkResult` is a
 * static value or a function we can use to throw.
 */
function makeRpc(
  capabilities: string[],
  walkResult: WalkResult | (() => Promise<WalkResult>),
): { rpc: RpcConnectionSlice; calls: number } {
  let calls = 0;
  const rpc: RpcConnectionSlice = {
    info: { capabilities },
    rpc: {
      call: vi.fn(async (method, params) => {
        calls++;
        expect(method).toBe('fs.walk');
        expect(params.recursive).toBe(true);
        return typeof walkResult === 'function' ? walkResult() : walkResult;
      }) as RpcConnectionSlice['rpc']['call'],
    },
  };
  return { rpc, calls: 0 } as unknown as { rpc: RpcConnectionSlice; calls: number };
  // (we mutate `calls` indirectly via the closure; assertion sites use rpc.rpc.call.mock.calls.length)
}

describe('BulkWalker', () => {
  // ─── fast path (rpc-walk) ───────────────────────────────────────────────

  it('uses fs.walk when the daemon advertises the capability', async () => {
    const adapter = makeAdapter({});
    const { rpc } = makeRpc(['fs.list', 'fs.walk', 'fs.stat'], {
      entries: [
        { path: 'docs',         type: 'folder', mtime: 1000, size: 0 },
        { path: 'docs/note.md', type: 'file',   mtime: 2000, size: 17 },
        { path: 'README.md',    type: 'file',   mtime: 3000, size: 42 },
      ],
      truncated: false,
    });
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    expect(result.source).toBe('rpc-walk');
    expect(result.truncated).toBe(false);
    expect(result.fastPathError).toBeNull();
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({ path: 'docs',         isDirectory: true,  mtime: 1000, size: 0 });
    expect(result.entries[1]).toMatchObject({ path: 'docs/note.md', isDirectory: false, mtime: 2000, size: 17 });
    expect(result.entries[2]).toMatchObject({ path: 'README.md',    isDirectory: false, mtime: 3000, size: 42 });
  });

  it('passes through the maxEntries override when set', async () => {
    const adapter = makeAdapter({});
    const callSpy = vi.fn(async () => ({ entries: [], truncated: false } as WalkResult));
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.walk'] },
      rpc: { call: callSpy as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({ adapter, rpcConnection: rpc, maxEntries: 7 });

    await walker.walk('');

    expect(callSpy).toHaveBeenCalledWith('fs.walk', { path: '', recursive: true, maxEntries: 7 });
  });

  // ─── fast path → fallback (truncated, error) ────────────────────────────

  it('falls back to per-folder list when the daemon returns truncated=true', async () => {
    const adapter = makeAdapter({
      '': { folders: ['docs'], files: ['README.md'] },
      'docs': { files: ['docs/a.md'] },
    });
    const { rpc } = makeRpc(['fs.walk'], {
      entries: [{ path: 'partial.md', type: 'file', mtime: 1, size: 1 }],
      truncated: true,
    });
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    expect(result.fastPathError).toBe('truncated');
    expect(result.entries.map(e => e.path).sort()).toEqual(['README.md', 'docs', 'docs/a.md']);
    // Fallback fills mtime/size with zeros (matches pre-walker behaviour).
    expect(result.entries.every(e => e.mtime === 0 && e.size === 0)).toBe(true);
  });

  it('falls back when the fs.walk RPC throws', async () => {
    const adapter = makeAdapter({
      '': { folders: ['x'], files: ['y.md'] },
      'x': { files: ['x/z.md'] },
    });
    const { rpc } = makeRpc(['fs.walk'], async () => { throw new Error('connection reset'); });
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    expect(result.fastPathError).toBe('connection reset');
    expect(result.entries.map(e => e.path).sort()).toEqual(['x', 'x/z.md', 'y.md']);
  });

  // ─── no fast path available ─────────────────────────────────────────────

  it('skips the fast path when no RPC connection is injected (= SFTP transport)', async () => {
    const adapter = makeAdapter({
      '':    { folders: ['notes'] },
      'notes': { files: ['notes/today.md'] },
    });
    const walker = new BulkWalker({ adapter /* no rpcConnection */ });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    expect(result.fastPathError).toBeNull();
    expect(result.entries.map(e => e.path).sort()).toEqual(['notes', 'notes/today.md']);
  });

  it('skips the fast path when the daemon does not advertise fs.walk', async () => {
    const adapter = makeAdapter({ '': { files: ['a.md'] } });
    const callSpy = vi.fn();
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.list', 'fs.stat'] },  // no fs.walk
      rpc: { call: callSpy as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    expect(callSpy).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback-list');
    expect(result.entries.map(e => e.path)).toEqual(['a.md']);
  });

  // ─── fallback resilience ────────────────────────────────────────────────

  it('fallback skips folders whose list() throws and keeps walking siblings', async () => {
    let listCalls = 0;
    const adapter: AdapterListSlice = {
      async list(p: string) {
        listCalls++;
        if (p === 'broken') throw new Error('permission denied');
        if (p === '')       return { files: ['ok.md'], folders: ['broken', 'good'] };
        if (p === 'good')   return { files: ['good/inside.md'], folders: [] };
        return { files: [], folders: [] };
      },
    };
    const walker = new BulkWalker({ adapter });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    expect(result.entries.map(e => e.path).sort()).toEqual(['broken', 'good', 'good/inside.md', 'ok.md']);
    expect(listCalls).toBeGreaterThan(0);
  });

  // ─── walkMs timing ──────────────────────────────────────────────────────

  it('records a non-negative walkMs', async () => {
    const adapter = makeAdapter({ '': { files: ['x.md'] } });
    const walker = new BulkWalker({ adapter });
    const result = await walker.walk('');
    expect(result.walkMs).toBeGreaterThanOrEqual(0);
  });
});
