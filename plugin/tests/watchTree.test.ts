import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { watchTree, listTreeFiles, type WatchTreeDeps } from '../src/util/watchTree';

/** Virtual root for the fake-platform tests; never touched on disk. */
const ROOT = path.join(path.sep === '\\' ? 'C:\\' : '/', 'vault-root');

const relOf = (abs: string): string =>
  path.relative(ROOT, abs).split(path.sep).join('/');

/**
 * Fake platform. `tree` maps a root-relative directory path ('' = the
 * root) to its immediate child directory names. `recursiveSupported`
 * decides whether a subtree watch is honoured — throwing is exactly
 * what Node does on a build without recursive support, and is the
 * condition `watchTree` must fall back on.
 */
function fakeDeps(tree: Record<string, string[]>, recursiveSupported: boolean) {
  const watched: string[] = [];
  const handlers = new Map<string, (f: string | null) => void>();
  const closed: string[] = [];
  const deps: WatchTreeDeps = {
    watch: (dir, recursive, onEvent) => {
      if (recursive && !recursiveSupported) {
        throw new Error('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
      }
      const rel = relOf(dir);
      watched.push(rel);
      handlers.set(rel, onEvent);
      return { close: () => { closed.push(rel); } };
    },
    listDirs: (dir) => tree[relOf(dir)] ?? [],
  };
  return {
    deps, watched, closed,
    emit: (relDir: string, filename: string | null) => handlers.get(relDir)?.(filename),
    isWatching: (relDir: string) => watched.includes(relDir),
  };
}

describe('watchTree', () => {
  it('uses the platform recursive watch when it is available', () => {
    const f = fakeDeps({}, true);
    const seen: (string | null)[] = [];
    watchTree(ROOT, (rel) => seen.push(rel), () => false, f.deps);

    expect(f.watched, 'more than the single recursive watcher was created').toEqual(['']);
    f.emit('', path.join('sub', 'note.md'));
    expect(seen, 'the reported path was not normalised to posix').toEqual(['sub/note.md']);
  });

  it('falls back to per-directory watchers when recursive is unsupported', () => {
    const f = fakeDeps({ '': ['sub'], 'sub': ['deep'], 'sub/deep': [] }, false);
    const seen: (string | null)[] = [];
    watchTree(ROOT, (rel) => seen.push(rel), () => false, f.deps);

    expect(f.isWatching(''), 'the root itself is unwatched').toBe(true);
    expect(f.isWatching('sub'), 'an existing subdirectory is unwatched').toBe(true);
    expect(f.isWatching('sub/deep'), 'the fallback did not recurse').toBe(true);

    f.emit('sub/deep', 'note.md');
    expect(seen).toEqual(['sub/deep/note.md']);
  });

  it('adopts a directory created after the watch started', () => {
    const tree: Record<string, string[]> = { '': [] };
    const f = fakeDeps(tree, false);
    watchTree(ROOT, () => { /* ignore */ }, () => false, f.deps);
    expect(f.isWatching('fresh')).toBe(false);

    // A plugin just created `fresh/` and the root watcher reports it.
    tree[''] = ['fresh'];
    tree['fresh'] = [];
    f.emit('', 'fresh');
    expect(
      f.isWatching('fresh'),
      'a new directory was never adopted — writes under it stay invisible',
    ).toBe(true);
  });

  it('does not watch pruned directories', () => {
    const f = fakeDeps({ '': ['.obsidian', 'notes'], '.obsidian': ['plugins'], 'notes': [] }, false);
    watchTree(ROOT, () => { /* ignore */ }, (rel) => rel.split('/')[0] === '.obsidian', f.deps);

    expect(f.isWatching('notes')).toBe(true);
    expect(f.isWatching('.obsidian'), 'the pruned config tree got a watcher').toBe(false);
    expect(f.isWatching('.obsidian/plugins')).toBe(false);
  });

  it('passes a filename-less event straight through as null', () => {
    const f = fakeDeps({ '': [] }, false);
    const seen: (string | null)[] = [];
    watchTree(ROOT, (rel) => seen.push(rel), () => false, f.deps);
    f.emit('', null);
    expect(seen).toEqual([null]);
  });

  it('close() releases every watcher it created', () => {
    const f = fakeDeps({ '': ['a'], 'a': [] }, false);
    const w = watchTree(ROOT, () => { /* ignore */ }, () => false, f.deps);
    w.close();
    expect(f.closed.sort()).toEqual(['', 'a']);
  });
});

describe('listTreeFiles', () => {
  const made: string[] = [];

  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function scaffold(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtree-'));
    made.push(root);
    fs.mkdirSync(path.join(root, 'folder', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, '.obsidian', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, 'note.md'), 'a');
    fs.writeFileSync(path.join(root, 'folder', 'nested', 'deep.md'), 'b');
    fs.writeFileSync(path.join(root, '.obsidian', 'app.json'), '{}');
    return root;
  }

  it('lists every file as a root-relative posix path', () => {
    const root = scaffold();
    expect(listTreeFiles(root).sort()).toEqual([
      '.obsidian/app.json', 'folder/nested/deep.md', 'note.md',
    ]);
  });

  it('honours the prune predicate for whole subtrees', () => {
    const root = scaffold();
    const files = listTreeFiles(root, (rel) => rel.split('/')[0] === '.obsidian');
    expect(files.sort()).toEqual(['folder/nested/deep.md', 'note.md']);
  });

  it('returns nothing for a root that does not exist', () => {
    expect(listTreeFiles(path.join(os.tmpdir(), 'watchtree-absent-root'))).toEqual([]);
  });
});
