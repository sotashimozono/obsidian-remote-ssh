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
});
