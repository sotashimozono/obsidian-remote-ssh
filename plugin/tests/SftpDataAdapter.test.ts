import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import { ReadCache } from '../src/cache/ReadCache';
import { DirCache } from '../src/cache/DirCache';
import { PathMapper } from '../src/path/PathMapper';
import { AncestorTracker } from '../src/conflict/AncestorTracker';
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

    it('handles an empty base ("") — used for RPC mode where the daemon already knows the vault root', () => {
      // In RPC mode the Go daemon's `--vault-root` provides the
      // absolute prefix; the client must send vault-relative paths to
      // avoid a double-prefix at the daemon's `Resolve` step.
      const fake = makeFakeClient();
      const adapter = new SftpDataAdapter(fake.client, '', readCache, dirCache, 'v');
      expect(adapter.toRemote('foo.md')).toBe('foo.md');
      expect(adapter.toRemote('dir/sub/note.md')).toBe('dir/sub/note.md');
      // Vault root maps to the empty string so the daemon's Resolve()
      // returns its absRoot unchanged.
      expect(adapter.toRemote('')).toBe('');
      expect(adapter.toRemote('/')).toBe('');
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

  // ─── PathMapper integration ───────────────────────────────────────────────
  //
  // These tests confirm that when an adapter is constructed with a
  // PathMapper, vault-relative reads/writes/lists for client-private
  // paths land in the per-client subtree on the remote, while ordinary
  // vault content (and shared `.obsidian/*` files) go to their nominal
  // locations unchanged.

  describe('with PathMapper', () => {
    it('redirects writes for private vault paths into .obsidian/user/<id>/', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v', new PathMapper('host-a'),
      );

      await adapter.write('.obsidian/workspace.json', '{"open":[]}');
      // The remote sees the per-client subtree, not the bare path.
      expect('/v/.obsidian/workspace.json' in fake.files).toBe(false);
      expect(fake.files['/v/.obsidian/user/host-a/workspace.json'].data.toString('utf8'))
        .toBe('{"open":[]}');
    });

    it('reads private paths from the per-client subtree', async () => {
      const fake = makeFakeClient({
        files: {
          '/v/.obsidian/user/host-a/workspace.json': { data: Buffer.from('{"a":1}'), mtime: 1 },
        },
        dirs: { '/v': [], '/v/.obsidian': [], '/v/.obsidian/user': [], '/v/.obsidian/user/host-a': [] },
      });
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v', new PathMapper('host-a'),
      );

      await expect(adapter.read('.obsidian/workspace.json')).resolves.toBe('{"a":1}');
    });

    it('passes non-private paths through to their nominal remote locations', async () => {
      const fake = makeFakeClient({ dirs: { '/v': [] } });
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v', new PathMapper('host-a'),
      );

      await adapter.write('Notes/foo.md', '# Hello');
      expect(fake.files['/v/Notes/foo.md'].data.toString('utf8')).toBe('# Hello');
      // Definitely not redirected.
      expect(Object.keys(fake.files).some(k => k.includes('user/host-a/Notes'))).toBe(false);
    });

    it('list(".obsidian") merges shared and per-client entries, hiding the user/ dir', async () => {
      const fake = makeFakeClient({
        files: {
          '/v/.obsidian/hotkeys.json': { data: Buffer.from('{}'), mtime: 1 },
          '/v/.obsidian/user/host-a/workspace.json': { data: Buffer.from('{}'), mtime: 1 },
        },
        dirs: {
          '/v': [],
          // Shared .obsidian (hotkeys.json + a plugins dir + the user-subtree dir)
          '/v/.obsidian': [
            { name: 'hotkeys.json', isFile: true, isDirectory: false, isSymbolicLink: false, mtime: 1, size: 2 },
            { name: 'plugins',      isFile: false, isDirectory: true, isSymbolicLink: false, mtime: 1, size: 0 },
            { name: 'user',         isFile: false, isDirectory: true, isSymbolicLink: false, mtime: 1, size: 0 },
          ],
          '/v/.obsidian/plugins': [],
          '/v/.obsidian/user': [
            { name: 'host-a', isFile: false, isDirectory: true, isSymbolicLink: false, mtime: 1, size: 0 },
          ],
          '/v/.obsidian/user/host-a': [
            { name: 'workspace.json', isFile: true, isDirectory: false, isSymbolicLink: false, mtime: 1, size: 2 },
          ],
        },
      });
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v', new PathMapper('host-a'),
      );

      const out = await adapter.list('.obsidian');
      // The `user/` directory is hidden; both private and shared
      // children appear under their nominal `.obsidian/...` paths.
      expect(out.folders.sort()).toEqual(['.obsidian/plugins']);
      expect(out.files.sort()).toEqual(['.obsidian/hotkeys.json', '.obsidian/workspace.json']);
    });

    it('list of a fully-private directory walks the per-client subtree', async () => {
      const fake = makeFakeClient({
        dirs: {
          '/v': [],
          '/v/.obsidian/user/host-a/cache': [
            { name: 'index.bin', isFile: true, isDirectory: false, isSymbolicLink: false, mtime: 1, size: 0 },
          ],
        },
      });
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v', new PathMapper('host-a'),
      );

      const out = await adapter.list('.obsidian/cache');
      expect(out.files).toEqual(['.obsidian/cache/index.bin']);
      expect(out.folders).toEqual([]);
    });

    it('toRemote on a private path returns the per-client absolute path', () => {
      const fake = makeFakeClient();
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v', new PathMapper('host-a'),
      );
      expect(adapter.toRemote('.obsidian/workspace.json'))
        .toBe('/v/.obsidian/user/host-a/workspace.json');
      expect(adapter.toRemote('Notes/x.md')).toBe('/v/Notes/x.md');
    });
  });

  describe('swapClient', () => {
    it('routes subsequent reads through the new client', async () => {
      const oldClient = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('OLD'), mtime: 1 } },
      });
      const newClient = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('NEW'), mtime: 2 } },
      });
      const adapter = new SftpDataAdapter(oldClient.client, '/v', readCache, dirCache, 'v');
      // Sanity: the adapter sees the old client's data first.
      expect(await adapter.read('note.md')).toBe('OLD');
      adapter.swapClient(newClient.client);
      // After swap, mtime mismatch invalidates the cache and the
      // newer client's data flows through.
      expect(await adapter.read('note.md')).toBe('NEW');
    });

    it('preserves cached entries across swaps when mtimes still match', async () => {
      const oldClient = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('SAME'), mtime: 7 } },
      });
      const newClient = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('SAME'), mtime: 7 } },
      });
      const adapter = new SftpDataAdapter(oldClient.client, '/v', readCache, dirCache, 'v');
      await adapter.read('note.md'); // primes cache
      adapter.swapClient(newClient.client);
      // Same mtime → cache hit, the new client only sees a stat call.
      const out = await adapter.read('note.md');
      expect(out).toBe('SAME');
      expect(newClient.client.readBinary).not.toHaveBeenCalled();
      expect(newClient.client.stat).toHaveBeenCalled();
    });
  });

  describe('setReconnecting (gate)', () => {
    it('serves reads from the cache while reconnecting', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('CACHED'), mtime: 1 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('note.md'); // prime cache
      fake.client.stat.mockClear();
      fake.client.readBinary.mockClear();
      adapter.setReconnecting(true);
      // Cached read is served without touching the (dead) client.
      expect(await adapter.read('note.md')).toBe('CACHED');
      expect(fake.client.stat).not.toHaveBeenCalled();
      expect(fake.client.readBinary).not.toHaveBeenCalled();
    });

    it('throws on a cache miss while reconnecting', async () => {
      const fake = makeFakeClient({});
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      adapter.setReconnecting(true);
      await expect(adapter.read('absent.md')).rejects.toThrow(/reconnecting/i);
    });

    it('throws on every write-side method while reconnecting', async () => {
      const fake = makeFakeClient({});
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      adapter.setReconnecting(true);
      const ab = new ArrayBuffer(0);
      await expect(adapter.write('a', 'x')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.writeBinary('a', ab)).rejects.toThrow(/reconnecting/i);
      await expect(adapter.append('a', 'x')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.appendBinary('a', ab)).rejects.toThrow(/reconnecting/i);
      await expect(adapter.process('a', x => x)).rejects.toThrow(/reconnecting/i);
      await expect(adapter.mkdir('d')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.remove('a')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.rmdir('d', false)).rejects.toThrow(/reconnecting/i);
      await expect(adapter.rename('a', 'b')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.copy('a', 'b')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.trashLocal('a')).rejects.toThrow(/reconnecting/i);
    });

    it('throws on stat / list / exists while reconnecting', async () => {
      const fake = makeFakeClient({});
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      adapter.setReconnecting(true);
      await expect(adapter.exists('x')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.stat('x')).rejects.toThrow(/reconnecting/i);
      await expect(adapter.list('')).rejects.toThrow(/reconnecting/i);
    });

    it('returns to normal once the gate is cleared', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hi'), mtime: 9 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      adapter.setReconnecting(true);
      await expect(adapter.write('note.md', 'data')).rejects.toThrow(/reconnecting/i);
      adapter.setReconnecting(false);
      await expect(adapter.read('note.md')).resolves.toBe('hi');
    });
  });

  describe('write conflict (expectedMtime + onWriteConflict)', () => {
    /**
     * Build a client whose `writeBinary` rejects with
     * PreconditionFailed whenever `expectedMtime` is supplied, and
     * succeeds (writing into the in-memory store) when it isn't. Lets
     * tests drive the "conflict, retry, success" path deterministically.
     */
    function makeConflictingClient() {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('initial'), mtime: 100 } },
      });
      const writeCalls: Array<{ path: string; expected?: number }> = [];
      fake.spies.writeBinary.mockImplementation(
        async (p: string, data: Buffer, expectedMtime?: number) => {
          writeCalls.push({ path: p, expected: expectedMtime });
          if (expectedMtime !== undefined) {
            const err = new Error('precondition failed') as Error & { code: number };
            err.code = -32020;
            throw err;
          }
          // Success path: write into the underlying in-memory store
          // directly so we don't recurse through the spy.
          fake.files[p] = { data: Buffer.from(data), mtime: 200 };
        },
      );
      return { fake, writeCalls };
    }

    it('passes the cached mtime as expectedMtime when the path was recently read', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hi'), mtime: 7 } },
      });
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('note.md'); // primes cache with mtime=7
      fake.spies.writeBinary.mockClear();
      await adapter.write('note.md', 'updated');
      expect(fake.spies.writeBinary).toHaveBeenCalledWith('/v/note.md', expect.any(Buffer), 7);
    });

    it('omits expectedMtime when the cache has no entry for the path', async () => {
      const fake = makeFakeClient({});
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.write('new.md', 'hello'); // first-touch write, no cache hit
      expect(fake.spies.writeBinary).toHaveBeenCalledWith('/v/new.md', expect.any(Buffer), undefined);
    });

    it('asks onWriteConflict + retries without expectedMtime when user picks overwrite', async () => {
      const { fake, writeCalls } = makeConflictingClient();
      const onConflict = vi.fn(async () => true);
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v',
        null, null, onConflict,
      );
      await adapter.read('note.md'); // primes mtime
      await adapter.write('note.md', 'force');
      expect(onConflict).toHaveBeenCalledWith('note.md');
      expect(writeCalls).toHaveLength(2);
      expect(writeCalls[0].expected).toBeDefined();
      expect(writeCalls[1].expected).toBeUndefined();
    });

    it('rethrows the precondition error when user cancels the conflict', async () => {
      const { fake } = makeConflictingClient();
      const onConflict = vi.fn(async () => false);
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v',
        null, null, onConflict,
      );
      await adapter.read('note.md');
      await expect(adapter.write('note.md', 'no')).rejects.toMatchObject({ code: -32020 });
      expect(onConflict).toHaveBeenCalledWith('note.md');
    });

    it('rethrows when there is no onWriteConflict callback', async () => {
      const { fake } = makeConflictingClient();
      const adapter = new SftpDataAdapter(fake.client, '/v', readCache, dirCache, 'v');
      await adapter.read('note.md');
      await expect(adapter.write('note.md', 'no')).rejects.toMatchObject({ code: -32020 });
    });

    it('rethrows non-precondition errors without consulting the callback', async () => {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('hi'), mtime: 1 } },
      });
      fake.spies.writeBinary.mockImplementation(async () => {
        throw new Error('disk full');
      });
      const onConflict = vi.fn(async () => true);
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v',
        null, null, onConflict,
      );
      await adapter.read('note.md');
      await expect(adapter.write('note.md', 'no')).rejects.toThrow(/disk full/);
      expect(onConflict).not.toHaveBeenCalled();
    });
  });

  describe('text 3-way merge conflict (AncestorTracker + onTextConflict)', () => {
    /**
     * Local copy of the parent describe's `makeConflictingClient`
     * helper — JS scoping keeps the original out of reach. Same
     * contract: any write with `expectedMtime` rejects with
     * PreconditionFailed; writes without it succeed.
     */
    function makeConflictingClient() {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from('initial'), mtime: 100 } },
      });
      const writeCalls: Array<{ path: string; expected?: number }> = [];
      fake.spies.writeBinary.mockImplementation(
        async (p: string, data: Buffer, expectedMtime?: number) => {
          writeCalls.push({ path: p, expected: expectedMtime });
          if (expectedMtime !== undefined) {
            const err = new Error('precondition failed') as Error & { code: number };
            err.code = -32020;
            throw err;
          }
          fake.files[p] = { data: Buffer.from(data), mtime: 200 };
        },
      );
      return { fake, writeCalls };
    }

    /**
     * Same shape as `makeConflictingClient` above, but the underlying
     * file's mtime advances on a successful (precondition-less) write
     * — the 3-way path does both the failed precondition write AND a
     * follow-up write, so we need the second write to land cleanly.
     */
    function makeTextConflictingClient(opts: {
      initialContent: string;
      initialMtime: number;
      theirsContent: string;
      theirsMtime: number;
    }) {
      const fake = makeFakeClient({
        files: { '/v/note.md': { data: Buffer.from(opts.initialContent), mtime: opts.initialMtime } },
      });
      // The "theirs" content is what the remote returns when the
      // adapter re-reads after the precondition failure. We stash it
      // straight into the fake's store so the conflict path's
      // `client.readBinary(remote)` picks it up.
      fake.files['/v/note.md'] = { data: Buffer.from(opts.theirsContent), mtime: opts.theirsMtime };

      const writeCalls: Array<{ path: string; expected?: number; data: string }> = [];
      fake.spies.writeBinary.mockImplementation(
        async (p: string, data: Buffer, expectedMtime?: number) => {
          writeCalls.push({ path: p, expected: expectedMtime, data: data.toString('utf8') });
          // Only the FIRST attempt (with expectedMtime) gets the
          // precondition error — retries land cleanly so the test can
          // observe what we ended up writing.
          if (expectedMtime !== undefined && writeCalls.length === 1) {
            const err = new Error('precondition failed') as Error & { code: number };
            err.code = -32020;
            throw err;
          }
          fake.files[p] = { data: Buffer.from(data), mtime: opts.theirsMtime + 1 };
        },
      );
      return { fake, writeCalls };
    }

    /** Re-prime the ancestor by reading first, then re-stash "theirs" into the fake store. */
    async function primeAndConflict(opts: {
      ancestorContent: string;
      mineContent: string;
      theirsContent: string;
      decision:
        | { decision: 'keep-mine' }
        | { decision: 'keep-theirs' }
        | { decision: 'merged'; content: string }
        | { decision: 'cancel' };
    }) {
      const tracker = new AncestorTracker();
      const onText = vi.fn(async () => opts.decision);
      const onLegacy = vi.fn(async () => false);
      const { fake, writeCalls } = makeTextConflictingClient({
        initialContent: opts.ancestorContent,
        initialMtime:   100,
        theirsContent:  opts.theirsContent,
        theirsMtime:    200,
      });
      // Reset the file to the ANCESTOR state for the priming read,
      // then swap it to THEIRS afterwards so the precondition fires.
      fake.files['/v/note.md'] = { data: Buffer.from(opts.ancestorContent), mtime: 100 };
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v',
        null, null, onLegacy, tracker, onText,
      );
      await adapter.read('note.md'); // ancestor primed: "ancestorContent" @ mtime 100
      // Now flip the file under the adapter's nose to simulate
      // another client having written "theirsContent" at mtime 200.
      fake.files['/v/note.md'] = { data: Buffer.from(opts.theirsContent), mtime: 200 };
      return { adapter, onText, onLegacy, writeCalls, fake };
    }

    it('routes a text PreconditionFailed through onTextConflict with the right panes', async () => {
      const { adapter, onText } = await primeAndConflict({
        ancestorContent: 'v0',
        mineContent:     'mine',
        theirsContent:   'theirs',
        decision:        { decision: 'keep-mine' },
      });
      await adapter.write('note.md', 'mine');
      expect(onText).toHaveBeenCalledTimes(1);
      const [path, panes] = onText.mock.calls[0];
      expect(path).toBe('note.md');
      expect(panes).toEqual({ ancestor: 'v0', mine: 'mine', theirs: 'theirs' });
    });

    it('keep-mine retries the write without expectedMtime and persists "mine"', async () => {
      const { adapter, writeCalls, fake } = await primeAndConflict({
        ancestorContent: 'v0',
        mineContent:     'mine',
        theirsContent:   'theirs',
        decision:        { decision: 'keep-mine' },
      });
      await adapter.write('note.md', 'mine');
      // First write: with expectedMtime (rejected). Second: without.
      expect(writeCalls).toHaveLength(2);
      expect(writeCalls[0].expected).toBeDefined();
      expect(writeCalls[1].expected).toBeUndefined();
      expect(writeCalls[1].data).toBe('mine');
      expect(fake.files['/v/note.md'].data.toString('utf8')).toBe('mine');
    });

    it('merged writes the user-supplied merged content', async () => {
      const { adapter, writeCalls, fake } = await primeAndConflict({
        ancestorContent: 'v0',
        mineContent:     'mine',
        theirsContent:   'theirs',
        decision:        { decision: 'merged', content: 'mine + theirs handled' },
      });
      await adapter.write('note.md', 'mine');
      expect(writeCalls[1].data).toBe('mine + theirs handled');
      expect(fake.files['/v/note.md'].data.toString('utf8')).toBe('mine + theirs handled');
    });

    it('keep-theirs rethrows + leaves the remote alone, refreshes cache to theirs', async () => {
      const { adapter, writeCalls, fake } = await primeAndConflict({
        ancestorContent: 'v0',
        mineContent:     'mine',
        theirsContent:   'theirs',
        decision:        { decision: 'keep-theirs' },
      });
      await expect(adapter.write('note.md', 'mine')).rejects.toMatchObject({ code: -32020 });
      // Only the failed first attempt happened.
      expect(writeCalls).toHaveLength(1);
      // Remote still has theirs.
      expect(fake.files['/v/note.md'].data.toString('utf8')).toBe('theirs');
      // Cache was refreshed: a follow-up read serves theirs without
      // another network round-trip — but we can verify by reading
      // through the adapter and confirming the value.
      expect(await adapter.read('note.md')).toBe('theirs');
    });

    it('cancel rethrows + leaves the remote alone', async () => {
      const { adapter, writeCalls, fake } = await primeAndConflict({
        ancestorContent: 'v0',
        mineContent:     'mine',
        theirsContent:   'theirs',
        decision:        { decision: 'cancel' },
      });
      await expect(adapter.write('note.md', 'mine')).rejects.toMatchObject({ code: -32020 });
      expect(writeCalls).toHaveLength(1);
      expect(fake.files['/v/note.md'].data.toString('utf8')).toBe('theirs');
    });

    it('falls back to the legacy two-choice modal when no ancestor is recorded', async () => {
      const tracker = new AncestorTracker();
      const onLegacy = vi.fn(async () => true /* overwrite */);
      const onText = vi.fn();
      const { fake, writeCalls } = makeConflictingClient();
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v',
        null, null, onLegacy, tracker, onText,
      );
      // Prime the readCache (so the write sends expectedMtime) but do
      // NOT populate the ancestor tracker — `readBinary` is the path
      // that touches readCache without touching the text-only tracker.
      await adapter.readBinary('note.md');
      await adapter.write('note.md', 'force');
      expect(onText).not.toHaveBeenCalled();
      expect(onLegacy).toHaveBeenCalledWith('note.md');
      expect(writeCalls[1].expected).toBeUndefined();
    });

    it('binary writeBinary uses the legacy two-choice modal even when ancestor + onTextConflict are wired', async () => {
      const tracker = new AncestorTracker();
      const onLegacy = vi.fn(async () => true);
      const onText = vi.fn();
      const { fake, writeCalls } = makeConflictingClient();
      // Prime the ancestor so a TEXT write would route through 3-way;
      // assert that the BINARY write does NOT.
      fake.files['/v/note.md'] = { data: Buffer.from('initial'), mtime: 100 };
      const adapter = new SftpDataAdapter(
        fake.client, '/v', readCache, dirCache, 'v',
        null, null, onLegacy, tracker, onText,
      );
      await adapter.read('note.md');
      await adapter.writeBinary('note.md', new Uint8Array([1, 2, 3]).buffer);
      expect(onText).not.toHaveBeenCalled();
      expect(onLegacy).toHaveBeenCalledWith('note.md');
      expect(writeCalls).toHaveLength(2);
    });
  });
});
