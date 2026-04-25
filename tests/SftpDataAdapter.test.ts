import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import { ReadCache } from '../src/cache/ReadCache';
import { DirCache } from '../src/cache/DirCache';
import type { RemoteEntry, RemoteStat } from '../src/types';

/** Minimal stand-in for SftpClient — only the read-side methods the adapter calls. */
function makeFakeClient(initial: {
  files?: Record<string, { data: Buffer; mtime: number }>;
  dirs?: Record<string, RemoteEntry[]>;
} = {}) {
  const files: Record<string, { data: Buffer; mtime: number }> = { ...(initial.files ?? {}) };
  const dirs: Record<string, RemoteEntry[]> = { ...(initial.dirs ?? {}) };

  const stat = vi.fn(async (p: string): Promise<RemoteStat> => {
    if (files[p]) {
      const f = files[p];
      return {
        isDirectory: false, isFile: true, isSymbolicLink: false,
        mtime: f.mtime, size: f.data.byteLength, mode: 0o100644,
      };
    }
    if (dirs[p]) {
      return {
        isDirectory: true, isFile: false, isSymbolicLink: false,
        mtime: 0, size: 0, mode: 0o040755,
      };
    }
    throw new Error('No such file');
  });

  const exists = vi.fn(async (p: string): Promise<boolean> => {
    return p in files || p in dirs;
  });

  const list = vi.fn(async (p: string): Promise<RemoteEntry[]> => {
    if (!(p in dirs)) throw new Error(`No such dir: ${p}`);
    return dirs[p];
  });

  const readBinary = vi.fn(async (p: string): Promise<Buffer> => {
    if (!(p in files)) throw new Error(`No such file: ${p}`);
    return files[p].data;
  });

  return {
    files, dirs,
    client: { stat, exists, list, readBinary } as unknown as import('../src/ssh/SftpClient').SftpClient,
    spies: { stat, exists, list, readBinary },
  };
}

const e = (name: string, isDirectory = false): RemoteEntry => ({
  name, isDirectory,
  isFile: !isDirectory,
  isSymbolicLink: false,
  mtime: 1000,
  size: 0,
});

describe('SftpDataAdapter (read-side)', () => {
  let readCache: ReadCache;
  let dirCache: DirCache;

  beforeEach(() => {
    readCache = new ReadCache({ maxBytes: 1024 });
    dirCache = new DirCache({ ttlMs: 10000 });
  });

  describe('getName / toRemote', () => {
    it('returns the configured vault name', () => {
      const fake = makeFakeClient();
      const adapter = new SftpDataAdapter(fake.client, '/srv/vault', readCache, dirCache, 'TestVault');
      expect(adapter.getName()).toBe('TestVault');
    });

    it('joins normalized path under the remote base', () => {
      const fake = makeFakeClient();
      const adapter = new SftpDataAdapter(fake.client, '/srv/vault', readCache, dirCache, 'v');
      expect(adapter.toRemote('')).toBe('/srv/vault');
      expect(adapter.toRemote('/')).toBe('/srv/vault');
      expect(adapter.toRemote('foo.md')).toBe('/srv/vault/foo.md');
      expect(adapter.toRemote('dir/sub/note.md')).toBe('/srv/vault/dir/sub/note.md');
    });

    it('handles a home-relative base ("work/VaultDev")', () => {
      const fake = makeFakeClient();
      const adapter = new SftpDataAdapter(fake.client, 'work/VaultDev', readCache, dirCache, 'v');
      expect(adapter.toRemote('foo.md')).toBe('work/VaultDev/foo.md');
      expect(adapter.toRemote('')).toBe('work/VaultDev');
    });

    it('handles a root base ("/")', () => {
      const fake = makeFakeClient();
      const adapter = new SftpDataAdapter(fake.client, '/', readCache, dirCache, 'v');
      expect(adapter.toRemote('foo.md')).toBe('/foo.md');
      expect(adapter.toRemote('')).toBe('/');
    });
  });

  describe('exists', () => {
    it('returns true for a file or folder that exists remotely', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hi'), mtime: 1 } },
        dirs:  { '/v': [e('note.md')] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await expect(adapter.exists('note.md')).resolves.toBe(true);
      await expect(adapter.exists('')).resolves.toBe(true);
    });

    it('returns false when the remote path is missing', async () => {
      const fake = makeFakeClient({});
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await expect(adapter.exists('missing.md')).resolves.toBe(false);
    });
  });

  describe('stat', () => {
    it('returns a Stat with mtime/size for a file', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hello'), mtime: 1234 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const s = await adapter.stat('note.md');
      expect(s).toEqual({ type: 'file', ctime: 1234, mtime: 1234, size: 5 });
    });

    it('returns "folder" type for a directory', async () => {
      const fake = makeFakeClient({ dirs: { '/v/sub': [] } });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const s = await adapter.stat('sub');
      expect(s?.type).toBe('folder');
    });

    it('returns null when the path does not exist', async () => {
      const fake = makeFakeClient({});
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await expect(adapter.stat('missing.md')).resolves.toBeNull();
    });
  });

  describe('list', () => {
    it('separates files and folders and returns vault-relative paths', async () => {
      const fake = makeFakeClient({
        dirs: { '/v/docs': [e('a.md'), e('b.md'), e('sub', true)] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const out = await adapter.list('docs');
      expect(out.files.sort()).toEqual(['docs/a.md', 'docs/b.md']);
      expect(out.folders).toEqual(['docs/sub']);
    });

    it('serves a vault-root listing without a leading slash', async () => {
      const fake = makeFakeClient({
        dirs: { '/v': [e('a.md'), e('docs', true)] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const out = await adapter.list('');
      expect(out.files).toEqual(['a.md']);
      expect(out.folders).toEqual(['docs']);
    });

    it('caches the second call within DirCache TTL', async () => {
      const fake = makeFakeClient({
        dirs: { '/v/docs': [e('a.md')] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.list('docs');
      await adapter.list('docs');
      expect(fake.spies.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('read', () => {
    it('returns utf8 string content', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('# Hello', 'utf8'), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await expect(adapter.read('note.md')).resolves.toBe('# Hello');
    });

    it('serves from ReadCache when mtime is unchanged (1 stat, 0 reads on the second call)', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hi'), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('note.md'); // miss: 1 read + 1 stat (post-read)
      const before = fake.spies.readBinary.mock.calls.length;
      await adapter.read('note.md'); // hit: 1 stat, 0 reads
      expect(fake.spies.readBinary.mock.calls.length - before).toBe(0);
    });

    it('refetches when mtime has advanced on the remote', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('v1'), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('note.md'); // populates cache with mtime=1
      // Simulate an out-of-band modification.
      fake.files['/v/note.md'] = { data: Buffer.from('v2'), mtime: 2 };
      await expect(adapter.read('note.md')).resolves.toBe('v2');
    });
  });

  describe('readBinary', () => {
    it('returns an ArrayBuffer copy (independent of the cached Buffer)', async () => {
      const fake = makeFakeClient({
        files: { '/v/img.png': { data: Buffer.from([1, 2, 3, 4]), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const ab = await adapter.readBinary('img.png');
      expect(ab).toBeInstanceOf(ArrayBuffer);
      const view = new Uint8Array(ab);
      expect([...view]).toEqual([1, 2, 3, 4]);
      // Mutating the returned view must not affect the cached entry.
      view[0] = 99;
      const cached = readCache.peek('/v/img.png');
      expect(cached?.data[0]).toBe(1);
    });
  });
});
