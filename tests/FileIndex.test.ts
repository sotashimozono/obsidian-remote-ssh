import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileIndex } from '../src/sync/FileIndex';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileIndex — in-memory operations', () => {
  let index: FileIndex;

  beforeEach(() => { index = new FileIndex(); });

  it('updateLocal and getLocal round-trip', () => {
    index.updateLocal('notes/a.md', { mtime: 1000, size: 42 });
    expect(index.getLocal('notes/a.md')).toEqual({ mtime: 1000, size: 42 });
  });

  it('updateRemote and getRemote round-trip', () => {
    index.updateRemote('notes/b.md', { mtime: 2000, size: 99 });
    expect(index.getRemote('notes/b.md')).toEqual({ mtime: 2000, size: 99 });
  });

  it('deleteLocal removes entry', () => {
    index.updateLocal('x.md', { mtime: 1, size: 1 });
    index.deleteLocal('x.md');
    expect(index.getLocal('x.md')).toBeUndefined();
  });

  it('deleteRemote removes entry', () => {
    index.updateRemote('x.md', { mtime: 1, size: 1 });
    index.deleteRemote('x.md');
    expect(index.getRemote('x.md')).toBeUndefined();
  });

  it('setRemoteEntries replaces all remote entries', () => {
    index.updateRemote('old.md', { mtime: 1, size: 1 });
    index.setRemoteEntries([
      { relativePath: 'new.md', mtime: 9000, size: 55, isDirectory: false },
    ]);
    expect(index.getRemote('old.md')).toBeUndefined();
    expect(index.getRemote('new.md')).toEqual({ mtime: 9000, size: 55 });
  });

  it('setRemoteEntries skips directories', () => {
    index.setRemoteEntries([
      { relativePath: 'dir', mtime: 1, size: 0, isDirectory: true },
      { relativePath: 'dir/file.md', mtime: 2, size: 10, isDirectory: false },
    ]);
    expect(index.getRemote('dir')).toBeUndefined();
    expect(index.getRemote('dir/file.md')).toBeDefined();
  });

  it('allRemotePaths returns all keys', () => {
    index.updateRemote('a.md', { mtime: 1, size: 1 });
    index.updateRemote('b.md', { mtime: 2, size: 2 });
    expect(index.allRemotePaths()).toContain('a.md');
    expect(index.allRemotePaths()).toContain('b.md');
  });
});

describe('FileIndex — persistence', () => {
  let tmpDir: string;
  let indexPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsh-test-'));
    indexPath = path.join(tmpDir, 'index.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persist writes JSON and load restores it', async () => {
    const index = new FileIndex();
    index.setIndexPath(indexPath);
    index.updateLocal('notes/a.md', { mtime: 1000, size: 42 });
    index.updateRemote('notes/a.md', { mtime: 2000, size: 50 });
    await index.persist();

    expect(fs.existsSync(indexPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(raw.local['notes/a.md']).toEqual({ mtime: 1000, size: 42 });
    expect(raw.remote['notes/a.md']).toEqual({ mtime: 2000, size: 50 });
  });

  it('load restores entries from disk', async () => {
    const a = new FileIndex();
    a.setIndexPath(indexPath);
    a.updateLocal('x.md', { mtime: 999, size: 7 });
    a.updateRemote('y.md', { mtime: 888, size: 3 });
    await a.persist();

    const b = new FileIndex();
    b.setIndexPath(indexPath);
    await b.load();
    expect(b.getLocal('x.md')).toEqual({ mtime: 999, size: 7 });
    expect(b.getRemote('y.md')).toEqual({ mtime: 888, size: 3 });
  });

  it('load on missing file starts fresh without error', async () => {
    const index = new FileIndex();
    index.setIndexPath('/nonexistent/path/index.json');
    await expect(index.load()).resolves.toBeUndefined();
    expect(index.allLocalPaths()).toHaveLength(0);
  });

  it('persist without indexPath is a no-op', async () => {
    const index = new FileIndex();
    await expect(index.persist()).resolves.toBeUndefined();
  });
});
