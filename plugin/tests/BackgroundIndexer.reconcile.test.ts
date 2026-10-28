import { describe, it, expect, vi } from 'vitest';
import { BackgroundIndexer, type IndexComplete } from '../src/vault/BackgroundIndexer';
import type { BulkWalker } from '../src/vault/BulkWalker';
import type { RemoteEntry, VaultModelBuilder } from '../src/vault/VaultModelBuilder';

// The reconcile half of the background index (#513): once the vault model can
// start from a tree snapshot, a complete walk must also update what changed and
// drop what the remote no longer has.

function file(path: string, mtime = 1, size = 1): RemoteEntry {
  return { path, isDirectory: false, ctime: mtime, mtime, size };
}
function dir(path: string): RemoteEntry {
  return { path, isDirectory: true, ctime: 0, mtime: 0, size: 0 };
}

function walkResult(
  entries: RemoteEntry[],
  over: Partial<{ truncated: boolean; source: 'rpc-walk' | 'fallback-list'; listErrors: number }> = {},
) {
  return {
    entries,
    source: over.source ?? ('rpc-walk' as const),
    truncated: over.truncated ?? false,
    walkMs: 1,
    pages: 1,
    fastPathError: over.source === 'fallback-list' ? 'fs.walk exploded' : null,
    hiddenCount: 0,
    listErrors: over.listErrors ?? 0,
  };
}

/** A model keyed by path, with the three builder operations the indexer uses. */
function makeModel(initial: RemoteEntry[]) {
  const model = new Map(initial.map((e) => [e.path, { ...e }]));
  const modifyOne = vi.fn((path: string, stat?: { ctime: number; mtime: number; size: number }) => {
    const e = model.get(path);
    if (!e || e.isDirectory) return false;
    if (stat) Object.assign(e, stat);
    return true;
  });
  const removeOne = vi.fn((path: string) => {
    if (!model.has(path)) return false;
    for (const k of [...model.keys()]) if (k === path || k.startsWith(path + '/')) model.delete(k);
    return true;
  });
  const buildChunked = vi.fn((entries: readonly RemoteEntry[]) => {
    let filesAdded = 0, foldersAdded = 0, skipped = 0;
    for (const e of entries) {
      if (model.has(e.path)) { skipped++; continue; }
      model.set(e.path, { ...e });
      if (e.isDirectory) foldersAdded++; else filesAdded++;
    }
    return Promise.resolve({ filesAdded, foldersAdded, skipped, errors: [] });
  });
  const builder = { buildChunked, modifyOne, removeOne } as unknown as VaultModelBuilder;
  return { model, builder, modifyOne, removeOne };
}

function childrenOf(tree: RemoteEntry[], folder: string): RemoteEntry[] {
  return tree.filter((e) => {
    const i = e.path.lastIndexOf('/');
    return (i < 0 ? '' : e.path.slice(0, i)) === folder;
  });
}

function makeIndexer(opts: {
  fastPath: boolean;
  remote: RemoteEntry[];
  model: ReturnType<typeof makeModel>;
  truncated?: boolean;
  /** What the walk actually came back as. `walk()` degrades on its own. */
  walkSource?: 'rpc-walk' | 'fallback-list';
  /** Folders the fallback could not list; their children are simply absent. */
  listErrors?: number;
  failFolder?: string;
  currentStat?: (p: string) => { mtime: number; size: number } | null;
  reconcile?: boolean;
  skip?: (path: string) => boolean;
  keep?: (path: string) => boolean;
  markLoaded?: (path: string) => void;
}) {
  const walk = vi.fn((path: string, recursive: boolean) => {
    if (opts.failFolder === path) return Promise.reject(new Error('EACCES'));
    return Promise.resolve(walkResult(recursive ? opts.remote : childrenOf(opts.remote, path), {
      truncated: opts.truncated,
      source: opts.walkSource,
      listErrors: opts.listErrors,
    }));
  });
  const walker = { hasFastPath: () => opts.fastPath, walk } as unknown as BulkWalker;
  const completions: IndexComplete[] = [];
  const indexer = new BackgroundIndexer({
    makeWalker: () => walker,
    makeBuilder: () => opts.model.builder,
    markLoaded: opts.markLoaded ?? (() => { /* noop */ }),
    yieldFn: () => Promise.resolve(),
    modelAtStart: opts.reconcile === false ? undefined : () => [...opts.model.model.values()].map((e) => ({ ...e })),
    currentStat: opts.currentStat,
    skip: opts.skip,
    keep: opts.keep,
    onComplete: (r) => completions.push(r),
  });
  return { indexer, completions };
}

describe('BackgroundIndexer reconcile', () => {
  it('fast path: updates the stat of a note that changed on the remote', async () => {
    const m = makeModel([file('a.md', 1, 10), file('b.md', 1, 10)]);
    const { indexer, completions } = makeIndexer({
      fastPath: true, model: m, remote: [file('a.md', 2, 12), file('b.md', 1, 10)],
    });
    await indexer.start();

    expect(m.modifyOne).toHaveBeenCalledExactlyOnceWith('a.md', { ctime: 2, mtime: 2, size: 12 });
    expect(m.model.get('a.md')).toMatchObject({ mtime: 2, size: 12 });
    expect(completions).toEqual([{ viaFastPath: true, modified: 1, removed: 0, complete: true }]);
  });

  it('fast path: updates a note whose only change is its ctime', async () => {
    const m = makeModel([{ ...file('a.md', 5, 10), ctime: 5 }]);
    const { indexer, completions } = makeIndexer({
      fastPath: true, model: m, remote: [{ ...file('a.md', 5, 10), ctime: 3 }],
    });
    await indexer.start();

    expect(m.modifyOne).toHaveBeenCalledExactlyOnceWith('a.md', { ctime: 3, mtime: 5, size: 10 });
    expect(completions).toEqual([{ viaFastPath: true, modified: 1, removed: 0, complete: true }]);
  });

  // An older daemon reports no `created`, so the walk's ctime is 0 (unknown).
  // Comparing it would fire `modify` on every edited note at every reconnect.
  it('fast path: does not compare a ctime the walk does not know', async () => {
    const m = makeModel([{ ...file('a.md', 5, 10), ctime: 3 }]);
    const { indexer } = makeIndexer({
      fastPath: true, model: m, remote: [{ ...file('a.md', 5, 10), ctime: 0 }],
    });
    await indexer.start();
    expect(m.modifyOne).not.toHaveBeenCalled();
  });

  it('fast path: keeps the modelled ctime when the walk does not know it', async () => {
    const m = makeModel([{ ...file('a.md', 5, 10), ctime: 3 }]);
    const { indexer } = makeIndexer({
      fastPath: true, model: m, remote: [{ ...file('a.md', 6, 12), ctime: 0 }],
    });
    await indexer.start();
    expect(m.modifyOne).toHaveBeenCalledExactlyOnceWith('a.md', { ctime: 3, mtime: 6, size: 12 });
  });

  it('fast path: drops notes and folders the remote no longer has', async () => {
    const m = makeModel([file('keep.md'), dir('old'), file('old/x.md'), file('gone.md')]);
    const { indexer, completions } = makeIndexer({ fastPath: true, model: m, remote: [file('keep.md')] });
    await indexer.start();

    expect([...m.model.keys()]).toEqual(['keep.md']);
    // The folder goes first and takes old/x.md with it, so that removeOne finds nothing.
    expect(completions[0].removed).toBe(2);
  });

  it('fast path: adds what is new, as before', async () => {
    const m = makeModel([file('a.md')]);
    const { indexer } = makeIndexer({ fastPath: true, model: m, remote: [file('a.md'), dir('n'), file('n/new.md')] });
    await indexer.start();
    expect(m.model.has('n/new.md')).toBe(true);
    expect(m.removeOne).not.toHaveBeenCalled();
  });

  it('never removes a note created after the pass started', async () => {
    const m = makeModel([file('a.md')]);
    const { indexer } = makeIndexer({ fastPath: true, model: m, remote: [file('a.md')] });
    const run = indexer.start();
    // A local create lands while the walk is in flight: not in the model at start.
    m.model.set('fresh.md', file('fresh.md'));
    await run;
    expect(m.model.has('fresh.md')).toBe(true);
  });

  describe('skip', () => {
    // An offline edit still queued: `new.md` was created and `gone.md` removed
    // locally, but the remote has neither change yet.
    const skip = (p: string) => p === 'new.md' || p === 'gone.md' || p === 'dir' || p.startsWith('dir/');

    it.each([['fast path', true], ['SFTP fallback', false]] as const)(
      '%s: never adds, updates or removes a skipped path', async (_label, fastPath) => {
        const m = makeModel([file('new.md'), file('kept.md', 1, 10), dir('dir'), file('dir/a.md', 1, 1)]);
        const { indexer } = makeIndexer({
          fastPath, model: m, skip,
          remote: [file('kept.md', 2, 12), file('gone.md'), dir('dir'), file('dir/a.md', 9, 9)],
        });
        await indexer.start();

        expect(m.model.has('new.md'), 'offline-created note kept').toBe(true);
        expect(m.model.has('gone.md'), 'offline-removed note not re-added').toBe(false);
        expect(m.model.get('dir/a.md')).toMatchObject({ mtime: 1 });
        if (fastPath) expect(m.model.get('kept.md')).toMatchObject({ mtime: 2, size: 12 });
      });

    it.each([['fast path', true], ['SFTP fallback', false]] as const)(
      '%s: marks a skipped folder loaded, so expanding it does not re-list it unfiltered', async (_l, fastPath) => {
        const marked: string[] = [];
        const { indexer } = makeIndexer({
          fastPath, model: makeModel([]), skip, markLoaded: (p) => marked.push(p),
          remote: [dir('dir'), file('dir/a.md')],
        });
        await indexer.start();

        expect(marked).toContain('dir');
      });

  });

  describe('keep', () => {
    // `a` holds a queued `a/new.md`: the remote does not have that note yet.
    const skip = (p: string) => p === 'a/new.md';
    const keep = (p: string) => p === 'a';

    it.each([['fast path', true], ['SFTP fallback', false]] as const)(
      '%s: never removes a kept folder the remote lacks (it would take the queued note with it)', async (_l, fastPath) => {
        // `a` itself was created offline; only its queued note names it.
        const m = makeModel([dir('a'), file('a/new.md')]);
        const { indexer } = makeIndexer({ fastPath, model: m, skip, keep, remote: [] });
        await indexer.start();

        expect([...m.model.keys()].sort()).toEqual(['a', 'a/new.md']);
      });

    it.each([['fast path', true], ['SFTP fallback', false]] as const)(
      '%s: adds a kept note the model lacks (written offline in an earlier launch)', async (_l, fastPath) => {
        const m = makeModel([dir('a')]);
        const { indexer } = makeIndexer({
          fastPath, model: m, keep: (p) => p === 'a' || p === 'a/new.md', remote: [dir('a'), file('a/new.md')],
        });
        await indexer.start();

        expect(m.model.has('a/new.md')).toBe(true);
      });

    it.each([['fast path', true], ['SFTP fallback', false]] as const)(
      '%s: never updates the stat of a kept note (the model has the newer edit)', async (_l, fastPath) => {
        const m = makeModel([file('n.md', 9, 99)]);
        const { indexer } = makeIndexer({ fastPath, model: m, keep: (p) => p === 'n.md', remote: [file('n.md', 1, 1)] });
        await indexer.start();

        expect(m.model.get('n.md')).toMatchObject({ mtime: 9, size: 99 });
      });

    it.each([['fast path', true], ['SFTP fallback', false]] as const)(
      '%s: still walks and reconciles under a kept folder', async (_l, fastPath) => {
        const m = makeModel([dir('a'), file('a/new.md'), file('a/old.md'), file('a/gone.md')]);
        const { indexer } = makeIndexer({
          fastPath, model: m, skip, keep,
          remote: [dir('a'), file('a/old.md')],
        });
        await indexer.start();

        expect([...m.model.keys()].sort()).toEqual(['a', 'a/new.md', 'a/old.md']);
      });

    it.each([['fast path', true], ['SFTP fallback', false]] as const)(
      '%s: still adds a kept folder the model lacks, so the notes under it can land', async (_l, fastPath) => {
        const m = makeModel([]);
        const { indexer } = makeIndexer({
          fastPath, model: m, skip, keep,
          remote: [dir('a'), file('a/old.md')],
        });
        await indexer.start();

        expect([...m.model.keys()].sort()).toEqual(['a', 'a/old.md']);
      });
  });

  it('skips a stat update when the note changed after the pass started', async () => {
    const m = makeModel([file('a.md', 1, 10)]);
    const { indexer } = makeIndexer({
      fastPath: true, model: m, remote: [file('a.md', 2, 12)],
      // A live fs.watch event already moved it past the walk.
      currentStat: () => ({ mtime: 3, size: 14 }),
    });
    await indexer.start();
    expect(m.modifyOne).not.toHaveBeenCalled();
  });

  it('treats a walk that degraded to the fallback as what it is', async () => {
    // `walk()` falls back to per-folder listing on its own when fs.walk throws
    // mid-pagination. Those entries carry mtime/size 0: believing them would
    // zero every note's stat and then persist that as the next snapshot.
    const m = makeModel([file('a.md', 5, 50), file('b.md', 5, 50)]);
    const { indexer, completions } = makeIndexer({
      fastPath: true, model: m, walkSource: 'fallback-list',
      remote: [file('a.md', 0, 0)],
    });
    await indexer.start();

    expect(m.modifyOne).not.toHaveBeenCalled();
    expect(m.model.get('a.md')).toMatchObject({ mtime: 5, size: 50 });
    expect(m.model.has('b.md')).toBe(true);
    expect(completions).toEqual([{ viaFastPath: false, modified: 0, removed: 0, complete: false }]);
  });

  it('does not remove anything when the walk could not list every folder', async () => {
    const m = makeModel([file('a.md'), file('b.md')]);
    const { indexer, completions } = makeIndexer({
      fastPath: true, model: m, remote: [file('a.md')], listErrors: 1,
    });
    await indexer.start();
    expect(m.model.has('b.md')).toBe(true);
    expect(completions[0].complete).toBe(false);
  });

  it('does not remove anything after a truncated walk', async () => {
    const m = makeModel([file('a.md'), file('b.md')]);
    const { indexer, completions } = makeIndexer({ fastPath: true, model: m, remote: [file('a.md')], truncated: true });
    await indexer.start();
    expect(m.model.has('b.md')).toBe(true);
    expect(completions[0].complete).toBe(false);
  });

  it('does nothing and reports nothing when cancelled', async () => {
    const m = makeModel([file('a.md'), file('b.md')]);
    const { indexer, completions } = makeIndexer({ fastPath: true, model: m, remote: [file('a.md')] });
    const run = indexer.start();
    indexer.cancel();
    await run;
    expect(m.model.has('b.md')).toBe(true);
    expect(completions).toEqual([]);
  });

  it('without modelAtStart it only fills in, as before', async () => {
    const m = makeModel([file('a.md', 1, 10), file('b.md')]);
    const { indexer } = makeIndexer({
      fastPath: true, model: m, remote: [file('a.md', 2, 12)], reconcile: false,
    });
    await indexer.start();
    expect(m.modifyOne).not.toHaveBeenCalled();
    expect(m.removeOne).not.toHaveBeenCalled();
  });

  it('still fills in when the model cannot be read', async () => {
    const m = makeModel([file('a.md')]);
    const walk = vi.fn(() => Promise.resolve(walkResult([file('a.md'), file('b.md')])));
    const completions: IndexComplete[] = [];
    await new BackgroundIndexer({
      makeWalker: () => ({ hasFastPath: () => true, walk }) as unknown as BulkWalker,
      makeBuilder: () => m.builder,
      markLoaded: () => { /* noop */ },
      yieldFn: () => Promise.resolve(),
      modelAtStart: () => { throw new Error('no getAllLoadedFiles'); },
      onComplete: (r) => completions.push(r),
    }).start();
    expect(m.model.has('b.md')).toBe(true);
    expect(completions).toEqual([{ viaFastPath: true, modified: 0, removed: 0, complete: false }]);
  });

  describe('SFTP fallback (stats are 0)', () => {
    it('removes what vanished but never compares stats', async () => {
      const m = makeModel([file('a.md', 5, 50), dir('d'), file('d/gone.md', 5, 50)]);
      const { indexer, completions } = makeIndexer({
        fastPath: false, model: m, remote: [file('a.md', 0, 0), dir('d')],
      });
      await indexer.start();
      expect(m.modifyOne).not.toHaveBeenCalled();
      expect(m.model.has('d/gone.md')).toBe(false);
      // Removals ran, but no stats were compared: not a full reconcile.
      expect(completions).toEqual([{ viaFastPath: false, modified: 0, removed: 1, complete: false }]);
    });

    it('is not complete when a folder walk threw', async () => {
      const m = makeModel([dir('d'), file('d/a.md')]);
      const { indexer, completions } = makeIndexer({
        fastPath: false, model: m, remote: [dir('d'), file('d/a.md')], failFolder: 'd',
      });
      await indexer.start();
      expect(completions[0].complete).toBe(false);
    });

    it('removes nothing when a folder walk threw', async () => {
      const m = makeModel([file('a.md'), dir('d'), file('d/x.md')]);
      const { indexer } = makeIndexer({
        fastPath: false, model: m, remote: [file('a.md'), dir('d'), file('d/x.md')], failFolder: 'd',
      });
      await indexer.start();
      expect(m.removeOne).not.toHaveBeenCalled();
      expect(m.model.has('d/x.md')).toBe(true);
    });

    it('removes nothing when a folder could not be listed', async () => {
      // The real fallback SWALLOWS a failed list and returns an empty set for
      // that folder, which reads exactly like "it is empty". Only listErrors
      // tells them apart — and without it every note under that folder would
      // be dropped from the model while it still exists on the remote.
      const m = makeModel([file('a.md'), dir('d'), file('d/x.md')]);
      const { indexer } = makeIndexer({
        fastPath: false, model: m, remote: [file('a.md'), dir('d')], listErrors: 1,
      });
      await indexer.start();
      expect(m.removeOne).not.toHaveBeenCalled();
      expect(m.model.has('d/x.md')).toBe(true);
    });
  });
});
