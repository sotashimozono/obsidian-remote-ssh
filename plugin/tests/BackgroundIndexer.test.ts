import { describe, it, expect, vi } from 'vitest';
import { BackgroundIndexer, type IndexProgress } from '../src/vault/BackgroundIndexer';
import type { BulkWalker } from '../src/vault/BulkWalker';
import type { RemoteEntry, VaultModelBuilder } from '../src/vault/VaultModelBuilder';

// ─── fixtures ───────────────────────────────────────────────────────────────

function file(path: string): RemoteEntry {
  return { path, isDirectory: false, ctime: 0, mtime: 0, size: 0 };
}
function dir(path: string): RemoteEntry {
  return { path, isDirectory: true, ctime: 0, mtime: 0, size: 0 };
}

function walkResult(entries: RemoteEntry[]) {
  return {
    entries,
    source: 'rpc-walk' as const,
    truncated: false,
    walkMs: 1,
    pages: 1,
    fastPathError: null,
    hiddenCount: 0,
  };
}

/**
 * A tree three levels deep. Only `root.md` and `work/` sit at depth 0 — i.e.
 * everything else is exactly what the lazy connect populate MISSES, and so
 * exactly what the background pass must register.
 */
const TREE: RemoteEntry[] = [
  file('root.md'),
  dir('work'),
  file('work/note.md'),
  dir('work/sub'),
  file('work/sub/deep.md'),
  file('work/sub/img.png'),
];

/** Immediate children of `folder` within TREE — what a one-level walk returns. */
function childrenOf(folder: string): RemoteEntry[] {
  return TREE.filter((e) => {
    const i = e.path.lastIndexOf('/');
    return (i < 0 ? '' : e.path.slice(0, i)) === folder;
  });
}

/**
 * A walker stub. `hasFastPath` selects which of the indexer's two traversal
 * strategies runs: the daemon's one-shot paginated `fs.walk`, or the SFTP
 * fallback's folder-at-a-time BFS.
 */
function makeWalker(opts: {
  fastPath: boolean;
  walk?: (path: string, recursive: boolean) => Promise<ReturnType<typeof walkResult>>;
}) {
  const walk = vi.fn(
    opts.walk ??
      ((path: string, recursive: boolean) =>
        Promise.resolve(walkResult(recursive ? TREE : childrenOf(path)))),
  );
  const walker = { hasFastPath: () => opts.fastPath, walk } as unknown as BulkWalker;
  return { walker, walk };
}

/**
 * A builder stub modelling the ONE property the indexer leans on for safety:
 * inserts are idempotent — an already-present path is counted as `skipped`, not
 * re-added. `present` seeds the paths the connect populate already registered.
 */
function makeBuilder(present: Iterable<string> = []) {
  const fileMap = new Set<string>(present);
  const buildChunked = vi.fn((entries: readonly RemoteEntry[], _chunkSize?: number) => {
    let filesAdded = 0, foldersAdded = 0, skipped = 0;
    for (const e of entries) {
      if (fileMap.has(e.path)) { skipped++; continue; }
      fileMap.add(e.path);
      if (e.isDirectory) foldersAdded++;
      else filesAdded++;
    }
    return Promise.resolve({ filesAdded, foldersAdded, skipped, errors: [] });
  });
  const builder = { buildChunked } as unknown as VaultModelBuilder;
  return { builder, buildChunked, fileMap };
}

function makeIndexer(
  walker: BulkWalker,
  builder: VaultModelBuilder,
  over: Partial<{
    markLoaded: (p: string) => void;
    onProgress: (p: IndexProgress) => void;
    yieldFn: () => Promise<void>;
  }> = {},
) {
  return new BackgroundIndexer({
    makeWalker: () => walker,
    makeBuilder: () => builder,
    markLoaded: over.markLoaded ?? (() => { /* noop */ }),
    onProgress: over.onProgress,
    yieldFn: over.yieldFn,
  });
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('BackgroundIndexer', () => {
  describe('walks beyond depth 1 (the defect)', () => {
    it('fast path: registers the whole tree, not just the root level', async () => {
      const { walker, walk } = makeWalker({ fastPath: true });
      // Seed what the lazy connect populate already did: the root level ONLY.
      const { builder, fileMap } = makeBuilder(['root.md', 'work']);
      await makeIndexer(walker, builder).start();

      // One recursive walk — the daemon paginates it server-side.
      expect(walk).toHaveBeenCalledExactlyOnceWith('', true);
      // The deep entries the lazy populate never saw are now in the model. These
      // are precisely the paths a `[[deep]]` link / `![[img.png]]` embed needs
      // present in `vault.fileMap` before metadataCache will resolve them.
      expect(fileMap).toContain('work/note.md');
      expect(fileMap).toContain('work/sub');
      expect(fileMap).toContain('work/sub/deep.md');
      expect(fileMap).toContain('work/sub/img.png');
    });

    it('fast path: inserts parents before children (depth-ascending)', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder, buildChunked } = makeBuilder();
      await makeIndexer(walker, builder).start();

      // Each buildChunked call is one depth level, shallowest first, so a file's
      // parent folder is always inserted in an EARLIER call than the file itself.
      const depths = buildChunked.mock.calls.map(([entries]) =>
        (entries as readonly RemoteEntry[]).map((e) => e.path.split('/').length - 1),
      );
      expect(depths).toEqual([[0, 0], [1, 1], [2, 2]]);
    });

    it('SFTP fallback: BFS walks one folder at a time, one level each', async () => {
      const { walker, walk } = makeWalker({ fastPath: false });
      const { builder, fileMap } = makeBuilder(['root.md', 'work']);
      await makeIndexer(walker, builder).start();

      // Root, then each folder it discovers — never a recursive walk, which on
      // the fallback transport is one adapter.list per dir with no yielding.
      expect(walk.mock.calls).toEqual([['', false], ['work', false], ['work/sub', false]]);
      expect(fileMap).toContain('work/sub/deep.md');
      expect(fileMap).toContain('work/sub/img.png');
    });
  });

  describe('idempotency against already-inserted paths', () => {
    it('re-registers nothing the connect populate already inserted', async () => {
      const { walker } = makeWalker({ fastPath: true });
      // Whole tree already present (the user expanded every folder, say) — the
      // indexer must add nothing and skip everything.
      const { builder } = makeBuilder(TREE.map((e) => e.path));
      const indexer = makeIndexer(walker, builder);
      await indexer.start();

      expect(indexer.inserted).toEqual({ files: 0, folders: 0 });
    });

    it('counts only what it actually added, so progress stays honest', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder } = makeBuilder(['root.md', 'work']);   // root level pre-seeded
      const indexer = makeIndexer(walker, builder);
      await indexer.start();

      // Added: work/note.md, work/sub/deep.md, work/sub/img.png + the work/sub dir.
      expect(indexer.inserted).toEqual({ files: 3, folders: 1 });
    });

    it('a path inserted MID-PASS by a racing lazy load / fs.changed is skipped, not double-counted', async () => {
      const { walker } = makeWalker({ fastPath: false });
      const { builder, fileMap, buildChunked } = makeBuilder(['root.md', 'work']);
      const indexer = makeIndexer(walker, builder, {
        // Simulate the click-driven LazyFolderLoader (or an fs.changed echo)
        // winning the race for `work/sub/deep.md` while the BFS is mid-pass.
        yieldFn: () => {
          fileMap.add('work/sub/deep.md');
          return Promise.resolve();
        },
      });
      await indexer.start();

      expect(fileMap).toContain('work/sub/deep.md');
      // The racing insert was SKIPPED by the builder, not counted a second time:
      // work/note.md + work/sub/img.png only.
      expect(indexer.inserted.files).toBe(2);
      const results = await Promise.all(
        buildChunked.mock.results.map((r) => r.value as Promise<{ filesAdded: number }>),
      );
      expect(results.reduce((n, t) => n + t.filesAdded, 0)).toBe(indexer.inserted.files);
    });
  });

  describe('marks folders loaded so the lazy loader skips them', () => {
    it('fast path: marks every folder in the tree', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder } = makeBuilder();
      const markLoaded = vi.fn();
      await makeIndexer(walker, builder, { markLoaded }).start();

      expect(markLoaded.mock.calls.map(([p]) => p as string)).toEqual(['work', 'work/sub']);
    });

    it('SFTP fallback: marks each folder as soon as its children are in', async () => {
      const { walker } = makeWalker({ fastPath: false });
      const { builder } = makeBuilder();
      const markLoaded = vi.fn();
      await makeIndexer(walker, builder, { markLoaded }).start();

      expect(markLoaded.mock.calls.map(([p]) => p as string))
        .toEqual(['', 'work', 'work/sub']);
    });

    it('does NOT mark a folder whose walk failed — an expand click can still retry it', async () => {
      const { walker } = makeWalker({
        fastPath: false,
        walk: (path: string) =>
          path === 'work/sub'
            ? Promise.reject(new Error('EACCES'))
            : Promise.resolve(walkResult(childrenOf(path))),
      });
      const { builder } = makeBuilder();
      const markLoaded = vi.fn();
      await makeIndexer(walker, builder, { markLoaded }).start();

      const marked = markLoaded.mock.calls.map(([p]) => p as string);
      expect(marked).toContain('work');          // readable folders still land
      expect(marked).not.toContain('work/sub');  // the failed one stays lazy
    });

    it('a cancelled fast-path pass marks nothing, so no folder falsely claims to be loaded', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder } = makeBuilder();
      const markLoaded = vi.fn();
      const indexer: BackgroundIndexer = makeIndexer(walker, builder, {
        markLoaded,
        yieldFn: () => { indexer.cancel(); return Promise.resolve(); },
      });
      await indexer.start();

      expect(markLoaded).not.toHaveBeenCalled();
    });
  });

  describe('stops on cancel / disconnect', () => {
    it('BFS stops walking once cancelled', async () => {
      const { walker, walk } = makeWalker({ fastPath: false });
      const { builder } = makeBuilder();
      const indexer: BackgroundIndexer = makeIndexer(walker, builder, {
        // Cancel after the very first folder — what disconnect() does mid-pass.
        yieldFn: () => { indexer.cancel(); return Promise.resolve(); },
      });
      await indexer.start();

      expect(walk).toHaveBeenCalledExactlyOnceWith('', false);   // never reached `work`
      expect(indexer.isCancelled).toBe(true);
      expect(indexer.isRunning).toBe(false);
    });

    it('cancelling before start means nothing is ever materialised', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder, buildChunked } = makeBuilder();
      const indexer = makeIndexer(walker, builder);
      indexer.cancel();
      await indexer.start();

      expect(buildChunked).not.toHaveBeenCalled();
      expect(indexer.inserted).toEqual({ files: 0, folders: 0 });
    });

    it('reports cancellation on the final progress emit', async () => {
      const { walker } = makeWalker({ fastPath: false });
      const { builder } = makeBuilder();
      const seen: IndexProgress[] = [];
      const indexer: BackgroundIndexer = makeIndexer(walker, builder, {
        onProgress: (p) => seen.push(p),
        yieldFn: () => { indexer.cancel(); return Promise.resolve(); },
      });
      await indexer.start();

      expect(seen[seen.length - 1]).toMatchObject({ done: true, cancelled: true });
    });

    it('a walk failure never sinks the session — the pass ends cleanly', async () => {
      const { walker } = makeWalker({
        fastPath: true,
        walk: () => Promise.reject(new Error('transport gone')),
      });
      const { builder } = makeBuilder();
      const seen: IndexProgress[] = [];
      const indexer = makeIndexer(walker, builder, { onProgress: (p) => seen.push(p) });

      await expect(indexer.start()).resolves.toBeUndefined();
      expect(seen[seen.length - 1]).toMatchObject({ done: true, files: 0, folders: 0, failed: true });
    });

    it('start() is idempotent — a second call joins the in-flight run', async () => {
      const { walker, walk } = makeWalker({ fastPath: true });
      const { builder } = makeBuilder();
      const indexer = makeIndexer(walker, builder);

      await Promise.all([indexer.start(), indexer.start()]);
      expect(walk).toHaveBeenCalledOnce();
    });
  });

  describe('does not block the main thread', () => {
    it('yields between every unit of work (BFS: one per folder)', async () => {
      const { walker } = makeWalker({ fastPath: false });
      const { builder } = makeBuilder();
      const yieldFn = vi.fn(() => Promise.resolve());
      await makeIndexer(walker, builder, { yieldFn }).start();

      expect(yieldFn).toHaveBeenCalledTimes(3);   // '', work, work/sub
    });

    it('fast path yields between depth levels rather than materialising in one tick', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder } = makeBuilder();
      const yieldFn = vi.fn(() => Promise.resolve());
      await makeIndexer(walker, builder, { yieldFn }).start();

      expect(yieldFn).toHaveBeenCalledTimes(3);   // depths 0, 1, 2
    });

    it('start() returns to the caller before doing any work', () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder, buildChunked } = makeBuilder();
      const indexer = makeIndexer(walker, builder);

      indexer.start();   // deliberately NOT awaited — this is the connect path

      // Connect returns with the model untouched; the tree fills in afterwards.
      expect(buildChunked).not.toHaveBeenCalled();
      expect(indexer.isRunning).toBe(true);
      indexer.cancel();
    });

    it('drives buildChunked with a smaller chunk than the connect populate (500)', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder, buildChunked } = makeBuilder();
      await makeIndexer(walker, builder).start();

      expect(buildChunked).toHaveBeenCalled();
      for (const [, chunkSize] of buildChunked.mock.calls) {
        expect(chunkSize).toBeLessThan(500);
      }
    });
  });

  describe('progress', () => {
    it('emits running progress and exactly one terminal done emit', async () => {
      const { walker } = makeWalker({ fastPath: true });
      const { builder } = makeBuilder(['root.md', 'work']);
      const seen: IndexProgress[] = [];
      await makeIndexer(walker, builder, { onProgress: (p) => seen.push(p) }).start();

      expect(seen.filter((p) => p.done)).toHaveLength(1);
      expect(seen.some((p) => !p.done)).toBe(true);
      expect(seen[seen.length - 1]).toEqual({
        files: 3, folders: 1, done: true, cancelled: false, failed: false,
      });
    });
  });
});
