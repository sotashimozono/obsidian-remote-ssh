import { describe, it, expect, vi } from 'vitest';
import { WsRemoteFsClient } from '../src/adapter/WsRemoteFsClient';

// ── WsRpcClient stub ──────────────────────────────────────────────────────────

function makeRpcClient(results: Record<string, unknown> = {}) {
  const closeHandlers: Array<(err?: Error) => void> = [];
  let closed = false;
  return {
    call: vi.fn(async (method: string, _params: unknown) => {
      if (!(method in results)) throw new Error(`No stub for ${method}`);
      return results[method];
    }),
    onClose(cb: (err?: Error) => void) {
      closeHandlers.push(cb);
      return () => {};
    },
    isClosed() { return closed; },
    close() { closed = true; for (const h of closeHandlers) h(); },
    _closeHandlers: closeHandlers,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function toB64(text: string): string {
  return btoa(text);
}

// ── WsRemoteFsClient tests ────────────────────────────────────────────────────

describe('WsRemoteFsClient — read side', () => {
  it('stat() converts Stat DTO to RemoteStat', async () => {
    const rpc = makeRpcClient({ 'fs.stat': { type: 'file', mtime: 1000, size: 42, mode: 0o644 } });
    const client = new WsRemoteFsClient(rpc as any);

    const s = await client.stat('/vault/note.md');
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.mtime).toBe(1000);
    expect(s.size).toBe(42);
    expect(rpc.call).toHaveBeenCalledWith('fs.stat', { path: '/vault/note.md' });
  });

  it('stat() throws when server returns null', async () => {
    const rpc = makeRpcClient({ 'fs.stat': null });
    const client = new WsRemoteFsClient(rpc as any);
    await expect(client.stat('/missing')).rejects.toThrow(/no such file/i);
  });

  it('exists() returns boolean', async () => {
    const rpc = makeRpcClient({ 'fs.exists': { exists: true } });
    const client = new WsRemoteFsClient(rpc as any);
    expect(await client.exists('/vault/note.md')).toBe(true);
  });

  it('list() maps entry DTOs to RemoteEntry[]', async () => {
    const rpc = makeRpcClient({
      'fs.list': {
        entries: [
          { name: 'note.md', type: 'file', mtime: 2000, size: 100 },
          { name: 'images', type: 'folder', mtime: 1500, size: 0 },
          { name: 'link.md', type: 'symlink', mtime: 1000, size: 0 },
        ],
      },
    });
    const client = new WsRemoteFsClient(rpc as any);
    const entries = await client.list('/vault');

    expect(entries[0]).toMatchObject({ name: 'note.md', isFile: true, isDirectory: false });
    expect(entries[1]).toMatchObject({ name: 'images', isDirectory: true });
    expect(entries[2]).toMatchObject({ name: 'link.md', isSymbolicLink: true });
  });

  it('readBinary() decodes base64 to Uint8Array', async () => {
    const content = 'hello binary';
    const rpc = makeRpcClient({ 'fs.readBinary': { contentBase64: toB64(content) } });
    const client = new WsRemoteFsClient(rpc as any);

    const data = await client.readBinary('/vault/file.bin');
    expect(new TextDecoder().decode(data)).toBe(content);
  });

  it('readBinaryRange() returns data + mtime + size', async () => {
    const rpc = makeRpcClient({
      'fs.readBinaryRange': { contentBase64: toB64('chunk'), mtime: 999, size: 500 },
    });
    const client = new WsRemoteFsClient(rpc as any);

    const r = await client.readBinaryRange('/vault/big.bin', 0, 5);
    expect(new TextDecoder().decode(r.data)).toBe('chunk');
    expect(r.mtime).toBe(999);
    expect(r.size).toBe(500);
    expect(rpc.call).toHaveBeenCalledWith('fs.readBinaryRange', { path: '/vault/big.bin', offset: 0, length: 5 });
  });
});

describe('WsRemoteFsClient — write side', () => {
  it('writeBinary() encodes Uint8Array as base64', async () => {
    const rpc = makeRpcClient({ 'fs.writeBinary': {} });
    const client = new WsRemoteFsClient(rpc as any);

    const data = new TextEncoder().encode('write me');
    await client.writeBinary('/vault/out.bin', data);

    expect(rpc.call).toHaveBeenCalledWith('fs.writeBinary', {
      path: '/vault/out.bin',
      contentBase64: toB64('write me'),
    });
  });

  it('writeBinary() passes expectedMtime when supplied', async () => {
    const rpc = makeRpcClient({ 'fs.writeBinary': {} });
    const client = new WsRemoteFsClient(rpc as any);

    await client.writeBinary('/vault/out.bin', new Uint8Array(), 12345);
    const args = (rpc.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(args['expectedMtime']).toBe(12345);
  });

  it('mkdirp() calls fs.mkdir with recursive:true', async () => {
    const rpc = makeRpcClient({ 'fs.mkdir': {} });
    const client = new WsRemoteFsClient(rpc as any);
    await client.mkdirp('/vault/subdir');
    expect(rpc.call).toHaveBeenCalledWith('fs.mkdir', { path: '/vault/subdir', recursive: true });
  });

  it('remove() delegates to fs.remove', async () => {
    const rpc = makeRpcClient({ 'fs.remove': {} });
    const client = new WsRemoteFsClient(rpc as any);
    await client.remove('/vault/old.md');
    expect(rpc.call).toHaveBeenCalledWith('fs.remove', { path: '/vault/old.md' });
  });

  it('rename() passes both paths', async () => {
    const rpc = makeRpcClient({ 'fs.rename': {} });
    const client = new WsRemoteFsClient(rpc as any);
    await client.rename('/vault/old.md', '/vault/new.md');
    expect(rpc.call).toHaveBeenCalledWith('fs.rename', { oldPath: '/vault/old.md', newPath: '/vault/new.md' });
  });
});

describe('WsRemoteFsClient — lifecycle', () => {
  it('isAlive() reflects rpc.isClosed()', () => {
    const rpc = makeRpcClient();
    const client = new WsRemoteFsClient(rpc as any);
    expect(client.isAlive()).toBe(true);
    rpc.close();
    expect(client.isAlive()).toBe(false);
  });

  it('onClose() fires with unexpected:false on clean close', () => {
    const rpc = makeRpcClient();
    const client = new WsRemoteFsClient(rpc as any);
    const cb = vi.fn();
    client.onClose(cb);
    rpc.close(); // no error → clean
    expect(cb).toHaveBeenCalledWith({ unexpected: false });
  });
});
