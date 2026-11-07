import { describe, it, expect, vi } from 'vitest';
import { RpcRemoteFsClient } from '../src/adapter/RpcRemoteFsClient';
import { RpcError } from '../src/transport/RpcError';
import type { RpcClient } from '../src/transport/RpcClient';

/**
 * RpcRemoteFsClient is a pure delegation layer: each method forwards
 * to a single RpcClient.call and reshapes the DTO if needed. Testing
 * it with a mocked RpcClient confirms the per-method method name,
 * params shape, and DTO conversion.
 */
function mockRpc(responders: Record<string, (params: unknown) => unknown>): RpcClient {
  return {
    isClosed: () => false,
    onClose: () => () => { /* noop */ },
    call: vi.fn(async (method: string, params: unknown) => {
      const handler = responders[method];
      if (!handler) throw new RpcError(-32601, `no fake for method ${method}`);
      return handler(params);
    }),
  } as unknown as RpcClient;
}

describe('RpcRemoteFsClient', () => {
  it('stat reshapes proto.Stat into RemoteStat', async () => {
    const client = new RpcRemoteFsClient(mockRpc({
      'fs.stat': (p) => {
        expect(p).toEqual({ path: 'note.md' });
        return { type: 'file', mtime: 123, size: 4, mode: 0o100644 };
      },
    }));
    const s = await client.stat('note.md');
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.mtime).toBe(123);
    expect(s.size).toBe(4);
  });

  // 0 isn't a creation time: it would read as 1970. Undefined means unknown.
  it('stat and list pass a positive created through and drop a 0', async () => {
    const client = new RpcRemoteFsClient(mockRpc({
      'fs.stat': (p) => ({ type: 'file', mtime: 123, created: (p as { path: string }).path === 'a.md' ? 50 : 0, size: 4, mode: 0o100644 }),
      'fs.list': () => ({ entries: [
        { name: 'a.md', type: 'file', mtime: 123, created: 50, size: 4 },
        { name: 'b.md', type: 'file', mtime: 123, created: 0, size: 4 },
      ] }),
    }));

    expect((await client.stat('a.md')).created).toBe(50);
    expect((await client.stat('b.md')).created).toBeUndefined();
    expect((await client.list('')).map(e => e.created)).toEqual([50, undefined]);
  });

  it('stat throws FileNotFound when the server returns null', async () => {
    const client = new RpcRemoteFsClient(mockRpc({
      'fs.stat': () => null,
    }));
    await expect(client.stat('gone.md')).rejects.toBeInstanceOf(RpcError);
    try {
      await client.stat('gone.md');
    } catch (e) {
      expect((e as RpcError).code).toBe(-32010);
    }
  });

  it('exists unwraps the boolean', async () => {
    const client = new RpcRemoteFsClient(mockRpc({
      'fs.exists': () => ({ exists: false }),
    }));
    expect(await client.exists('x')).toBe(false);
  });

  it('list reshapes Entry[] into RemoteEntry[]', async () => {
    const client = new RpcRemoteFsClient(mockRpc({
      'fs.list': () => ({
        entries: [
          { name: 'a.md',   type: 'file',    mtime: 1, size: 2 },
          { name: 'docs',   type: 'folder',  mtime: 3, size: 0 },
          { name: 'link.md', type: 'symlink', mtime: 5, size: 0 },
        ],
      }),
    }));
    const entries = await client.list('');
    expect(entries.length).toBe(3);
    expect(entries[0].isFile).toBe(true);
    expect(entries[1].isDirectory).toBe(true);
    expect(entries[2].isSymbolicLink).toBe(true);
  });

  it('readBinary base64-decodes the server payload', async () => {
    const client = new RpcRemoteFsClient(mockRpc({
      'fs.readBinary': () => ({
        contentBase64: Buffer.from([10, 20, 30]).toString('base64'),
        mtime: 0,
        size: 3,
      }),
    }));
    const buf = await client.readBinary('x.bin');
    expect([...buf]).toEqual([10, 20, 30]);
  });

  it('writeBinary base64-encodes the payload', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'fs.writeBinary') return { mtime: 1 };
        throw new RpcError(-32601, method);
      }),
    } as unknown as RpcClient);

    await client.writeBinary('x.bin', Buffer.from([1, 2, 3]));
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('fs.writeBinary');
    const params = calls[0].params as { path: string; contentBase64: string };
    expect(params.path).toBe('x.bin');
    expect(Buffer.from(params.contentBase64, 'base64').toString('hex')).toBe('010203');
    expect((params as { expectedMtime?: number }).expectedMtime).toBeUndefined();
  });

  it('writeBinary forwards expectedMtime when provided', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'fs.writeBinary') return { mtime: 2 };
        throw new RpcError(-32601, method);
      }),
    } as unknown as RpcClient);

    await client.writeBinary('x.bin', Buffer.from([1]), 1234);
    const params = calls[0].params as { expectedMtime?: number };
    expect(params.expectedMtime).toBe(1234);
  });

  it('mkdirp maps to fs.mkdir with recursive=true', async () => {
    const spy = vi.fn(async () => ({}));
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: spy,
    } as unknown as RpcClient);
    await client.mkdirp('docs/sub');
    expect(spy).toHaveBeenCalledWith('fs.mkdir', { path: 'docs/sub', recursive: true });
  });

  it('remove maps to fs.remove', async () => {
    const spy = vi.fn(async () => ({}));
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: spy,
    } as unknown as RpcClient);
    await client.remove('a.md');
    expect(spy).toHaveBeenCalledWith('fs.remove', { path: 'a.md' });
  });

  it('rmdir defaults recursive to false', async () => {
    const spy = vi.fn(async () => ({}));
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: spy,
    } as unknown as RpcClient);
    await client.rmdir('empty-dir');
    expect(spy).toHaveBeenCalledWith('fs.rmdir', { path: 'empty-dir', recursive: false });
  });

  it('rename forwards old/new paths', async () => {
    const spy = vi.fn(async () => ({ mtime: 42 }));
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: spy,
    } as unknown as RpcClient);
    await client.rename('old.md', 'new.md');
    expect(spy).toHaveBeenCalledWith('fs.rename', { oldPath: 'old.md', newPath: 'new.md' });
  });

  it('copy forwards src/dest paths', async () => {
    const spy = vi.fn(async () => ({ mtime: 42 }));
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: spy,
    } as unknown as RpcClient);
    await client.copy('a.md', 'b.md');
    expect(spy).toHaveBeenCalledWith('fs.copy', { srcPath: 'a.md', destPath: 'b.md' });
  });

  it('isAlive mirrors the RpcClient closed state', () => {
    const fake = { isClosed: vi.fn(() => false), onClose: () => () => { /* noop */ }, call: vi.fn() };
    const client = new RpcRemoteFsClient(fake as unknown as RpcClient);
    expect(client.isAlive()).toBe(true);
    fake.isClosed = vi.fn(() => true);
    expect(client.isAlive()).toBe(false);
  });

  // ─── readBinaryRange (#134) ───────────────────────────────────────────

  it('readBinaryRange forwards offset/length and decodes the slice', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const slice = Buffer.from([100, 101, 102, 103]);
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'fs.readBinaryRange') {
          return { contentBase64: slice.toString('base64'), mtime: 12345, size: 1024 };
        }
        throw new RpcError(-32601, method);
      }),
    } as unknown as RpcClient);

    const result = await client.readBinaryRange('big.bin', 100, 4);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('fs.readBinaryRange');
    expect(calls[0].params).toEqual({ path: 'big.bin', offset: 100, length: 4 });
    expect([...result.data]).toEqual([100, 101, 102, 103]);
    expect(result.mtime).toBe(12345);
    expect(result.size).toBe(1024); // total file size, not slice length
  });

  it('readBinaryRange forwards expectedMtime when provided', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { contentBase64: '', mtime: 999, size: 50 };
      }),
    } as unknown as RpcClient);

    await client.readBinaryRange('x.bin', 0, 10, 999);
    const params = calls[0].params as { expectedMtime?: number };
    expect(params.expectedMtime).toBe(999);
  });

  it('readBinaryRange omits expectedMtime when not provided', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = new RpcRemoteFsClient({
      isClosed: () => false,
      onClose: () => () => { /* noop */ },
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { contentBase64: '', mtime: 0, size: 0 };
      }),
    } as unknown as RpcClient);

    await client.readBinaryRange('x.bin', 0, 10);
    const params = calls[0].params as Record<string, unknown>;
    expect('expectedMtime' in params).toBe(false);
  });

  it('readBinaryRange returns an empty Buffer when the slice is empty (past EOF)', async () => {
    const client = new RpcRemoteFsClient(mockRpc({
      'fs.readBinaryRange': () => ({ contentBase64: '', mtime: 0, size: 50 }),
    }));
    const result = await client.readBinaryRange('x.bin', 100, 10);
    expect(result.data.byteLength).toBe(0);
    expect(result.size).toBe(50);
  });
});

// ─── close translation ───────────────────────────────────────────────────────
//
// The `mockRpc` above hands `onClose` a stub that throws the callback away,
// so this method had never run. It carries one bit — whether the close was
// unexpected — and `main.ts` starts a reconnect loop on it. Invert that bit
// and either every deliberate disconnect reconnects itself, or a real drop
// is ignored.

describe('RpcRemoteFsClient.onClose', () => {
  function capturing() {
    let cb: ((err?: Error) => void) | undefined;
    const unsubscribe = vi.fn();
    const rpc = {
      isClosed: () => false,
      onClose: (f: (err?: Error) => void) => { cb = f; return unsubscribe; },
      call: vi.fn(),
    } as unknown as RpcClient;
    return { rpc, fire: (err?: Error) => cb?.(err), unsubscribe };
  }

  it('reports a close carrying an error as unexpected', () => {
    const { rpc, fire } = capturing();
    const seen: Array<{ unexpected: boolean }> = [];
    new RpcRemoteFsClient(rpc).onClose((e) => seen.push(e));

    fire(new Error('daemon died'));

    expect(seen).toEqual([{ unexpected: true }]);
  });

  it('reports a close with no reason as expected', () => {
    // A disconnect we asked for. Treating it as unexpected would have the
    // plugin reconnect to the session the user just closed.
    const { rpc, fire } = capturing();
    const seen: Array<{ unexpected: boolean }> = [];
    new RpcRemoteFsClient(rpc).onClose((e) => seen.push(e));

    fire(undefined);

    expect(seen).toEqual([{ unexpected: false }]);
  });

  it('hands back the underlying unsubscribe', () => {
    const { rpc, unsubscribe } = capturing();

    const off = new RpcRemoteFsClient(rpc).onClose(() => { /* ignored */ });
    off();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
