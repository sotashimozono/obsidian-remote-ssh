import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import { ReadCache } from '../src/cache/ReadCache';
import { DirCache } from '../src/cache/DirCache';
import type { RemoteEntry, RemoteStat } from '../src/types';

/** Minimal stand-in for SftpClient covering both read- and write-side calls. */
function makeFakeClient(initial: {
  files?: Record<string, { data: Buffer; mtime: number }>;
  dirs?: Record<string, RemoteEntry[]>;
} = {}) {
  const files: Record<string, { data: Buffer; mtime: number }> = { ...(initial.files ?? {}) };
  const dirs: Record<string, RemoteEntry[]> = { ...(initial.dirs ?? {}) };
  let clock = 1000;
  const tick = () => ++clock;

  const dirEntry = (name: string, isDirectory: boolean): RemoteEntry => ({
    name, isDirectory,
    isFile: !isDirectory,
    isSymbolicLink: false,
    mtime: 0, size: 0,
  });

  /** Walk parent dirs and add `name` to each parent's dir listing. */
  const linkIntoParent = (fullPath: string, isDirectory: boolean): void => {
    const i = fullPath.lastIndexOf('/');
    if (i <= 0) return;
    const parent = fullPath.slice(0, i) || '/';
    const name = fullPath.slice(i + 1);
    if (!(parent in dirs)) dirs[parent] = [];
    const existingIdx = dirs[parent].findIndex(e => e.name === name);
    if (existingIdx >= 0) dirs[parent][existingIdx] = dirEntry(name, isDirectory);
    else dirs[parent].push(dirEntry(name, isDirectory));
  };

  const unlinkFromParent = (fullPath: string): void => {
    const i = fullPath.lastIndexOf('/');
    if (i <= 0) return;
    const parent = fullPath.slice(0, i) || '/';
    const name = fullPath.slice(i + 1);
    if (!(parent in dirs)) return;
    dirs[parent] = dirs[parent].filter(e => e.name !== name);
  };

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

  const writeBinary = vi.fn(async (p: string, data: Buffer): Promise<void> => {
    files[p] = { data: Buffer.from(data), mtime: tick() };
    linkIntoParent(p, false);
  });

  const mkdirp = vi.fn(async (p: string): Promise<void> => {
    if (!p) return;
    const parts = p.split('/').filter(Boolean);
    const isAbs = p.startsWith('/');
    let current = '';
    for (const part of parts) {
      current = isAbs ? current + '/' + part : (current ? current + '/' + part : part);
      if (!(current in dirs)) {
        dirs[current] = [];
        linkIntoParent(current, true);
      }
    }
  });

  const rename = vi.fn(async (oldPath: string, newPath: string): Promise<void> => {
    if (oldPath in files) {
      files[newPath] = files[oldPath];
      delete files[oldPath];
      unlinkFromParent(oldPath);
      linkIntoParent(newPath, false);
    } else if (oldPath in dirs) {
      dirs[newPath] = dirs[oldPath];
      delete dirs[oldPath];
      unlinkFromParent(oldPath);
      linkIntoParent(newPath, true);
    } else {
      throw new Error(`rename: no such path "${oldPath}"`);
    }
  });

  const copy = vi.fn(async (src: string, dst: string): Promise<void> => {
    if (!(src in files)) throw new Error(`copy: no such file "${src}"`);
    files[dst] = { data: Buffer.from(files[src].data), mtime: tick() };
    linkIntoParent(dst, false);
  });

  const remove = vi.fn(async (p: string): Promise<void> => {
    if (!(p in files)) throw new Error(`remove: no such file "${p}"`);
    delete files[p];
    unlinkFromParent(p);
  });

  const rmdir = vi.fn(async (p: string, recursive = false): Promise<void> => {
    if (!(p in dirs)) throw new Error(`rmdir: no such dir "${p}"`);
    if (recursive) {
      const prefix = p.endsWith('/') ? p : p + '/';
      for (const f of Object.keys(files)) {
        if (f === p || f.startsWith(prefix)) { delete files[f]; }
      }
      for (const d of Object.keys(dirs)) {
        if (d !== p && (d === p || d.startsWith(prefix))) { delete dirs[d]; }
      }
    } else if (dirs[p].length > 0) {
      throw new Error('rmdir: not empty');
    }
    delete dirs[p];
    unlinkFromParent(p);
  });

  return {
    files, dirs,
    client: {
      stat, exists, list, readBinary,
      writeBinary, mkdirp, rename, copy, remove, rmdir,
    } as unknown as import('../src/ssh/SftpClient').SftpClient,
    spies: { stat, exists, list, readBinary, writeBinary, mkdirp, rename, copy, remove, rmdir },
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
      view[0] = 99;
      const cached = readCache.peek('/v/img.png');
      expect(cached?.data[0]).toBe(1);
    });
  });

  describe('write', () => {
    it('persists text content and refreshes ReadCache with the new mtime', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.write('note.md', 'hello');
      expect(fake.files['/v/note.md'].data.toString('utf8')).toBe('hello');
      const cached = readCache.peek('/v/note.md');
      expect(cached?.data.toString('utf8')).toBe('hello');
      expect(cached?.mtime).toBe(fake.files['/v/note.md'].mtime);
    });

    it('writeBinary round-trips an ArrayBuffer faithfully', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const ab = new ArrayBuffer(4);
      new Uint8Array(ab).set([10, 20, 30, 40]);
      await adapter.writeBinary('blob.bin', ab);
      expect([...fake.files['/v/blob.bin'].data]).toEqual([10, 20, 30, 40]);
    });

    it('creates parent directories on the way to the file', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.write('docs/sub/a.md', 'x');
      expect(fake.dirs['/v/docs']).toBeDefined();
      expect(fake.dirs['/v/docs/sub']).toBeDefined();
      expect(fake.files['/v/docs/sub/a.md'].data.toString('utf8')).toBe('x');
    });

    it('invalidates the parent dir entry in DirCache after a write', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      // Prime DirCache with an empty listing so we can observe invalidation.
      await adapter.list('');
      expect(dirCache.get('/v')).not.toBeNull();
      await adapter.write('note.md', 'hi');
      expect(dirCache.get('/v')).toBeNull();
    });
  });

  describe('append', () => {
    it('appends text to an existing file', async () => {
      const fake = makeFakeClient({
        files: { '/v/log.md': { data: Buffer.from('first\n'), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.append('log.md', 'second\n');
      expect(fake.files['/v/log.md'].data.toString('utf8')).toBe('first\nsecond\n');
    });

    it('creates the file when it does not exist yet', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.append('new.md', 'hello');
      expect(fake.files['/v/new.md'].data.toString('utf8')).toBe('hello');
    });

    it('appendBinary concatenates bytes', async () => {
      const fake = makeFakeClient({
        files: { '/v/blob.bin': { data: Buffer.from([1, 2]), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const more = new ArrayBuffer(2);
      new Uint8Array(more).set([3, 4]);
      await adapter.appendBinary('blob.bin', more);
      expect([...fake.files['/v/blob.bin'].data]).toEqual([1, 2, 3, 4]);
    });
  });

  describe('process', () => {
    it('reads, transforms, writes back, and returns the new content', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hello'), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      const result = await adapter.process('note.md', s => s.toUpperCase());
      expect(result).toBe('HELLO');
      expect(fake.files['/v/note.md'].data.toString('utf8')).toBe('HELLO');
    });
  });

  describe('mkdir / remove / rmdir', () => {
    it('mkdir creates the directory chain', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.mkdir('a/b/c');
      expect(fake.dirs['/v/a/b/c']).toBeDefined();
    });

    it('remove deletes the file and invalidates the entry in ReadCache', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hi'), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('note.md'); // populate the cache
      expect(readCache.peek('/v/note.md')).not.toBeNull();
      await adapter.remove('note.md');
      expect('/v/note.md' in fake.files).toBe(false);
      expect(readCache.peek('/v/note.md')).toBeNull();
    });

    it('rmdir(recursive) removes the dir and invalidates the prefix in both caches', async () => {
      const fake = makeFakeClient({
        files: { '/v/dir/a.md': { data: Buffer.from('a'), mtime: 1 } },
        dirs:  { '/v': [], '/v/dir': [] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('dir/a.md'); // populate ReadCache
      await adapter.list('dir');      // populate DirCache
      await adapter.rmdir('dir', true);
      expect('/v/dir' in fake.dirs).toBe(false);
      expect(readCache.peek('/v/dir/a.md')).toBeNull();
      expect(dirCache.get('/v/dir')).toBeNull();
    });
  });

  describe('rename / copy', () => {
    it('rename moves a file and invalidates the old prefix in caches', async () => {
      const fake = makeFakeClient({
        files: { '/v/old.md': { data: Buffer.from('content'), mtime: 1 } },
        dirs: { '/v': [] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('old.md'); // cache it
      await adapter.rename('old.md', 'new.md');
      expect(fake.files['/v/new.md'].data.toString('utf8')).toBe('content');
      expect('/v/old.md' in fake.files).toBe(false);
      expect(readCache.peek('/v/old.md')).toBeNull();
    });

    it('rename creates the destination parent dirs', async () => {
      const fake = makeFakeClient({
        files: { '/v/a.md': { data: Buffer.from('x'), mtime: 1 } },
        dirs: { '/v': [] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.rename('a.md', 'archived/2026/a.md');
      expect(fake.dirs['/v/archived/2026']).toBeDefined();
      expect(fake.files['/v/archived/2026/a.md'].data.toString('utf8')).toBe('x');
    });

    it('copy duplicates the file and invalidates the new path in ReadCache', async () => {
      const fake = makeFakeClient({
        files: { '/v/src.md': { data: Buffer.from('src'), mtime: 1 } },
        dirs: { '/v': [] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.copy('src.md', 'dst.md');
      expect(fake.files['/v/dst.md'].data.toString('utf8')).toBe('src');
      expect(fake.files['/v/src.md'].data.toString('utf8')).toBe('src'); // src untouched
    });
  });

  describe('trash', () => {
    it('trashSystem returns false unconditionally so Obsidian falls back to local trash', async () => {
      const fake = makeFakeClient({
        files: { '/v/a.md': { data: Buffer.from('x'), mtime: 1 } },
        dirs: { '/v': [] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await expect(adapter.trashSystem('a.md')).resolves.toBe(false);
      // Must not be moved or deleted.
      expect(fake.files['/v/a.md'].data.toString('utf8')).toBe('x');
    });

    it('trashLocal moves the path under <vault>/.trash/', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('bye'), mtime: 1 } },
        dirs: { '/v': [] },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.trashLocal('note.md');
      expect('/v/note.md' in fake.files).toBe(false);
      expect(fake.files['/v/.trash/note.md'].data.toString('utf8')).toBe('bye');
    });
  });
});
