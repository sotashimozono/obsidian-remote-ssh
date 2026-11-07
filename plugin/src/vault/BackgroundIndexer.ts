import type { BulkWalker } from './BulkWalker';
import type { RemoteEntry, VaultModelBuilder } from './VaultModelBuilder';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/** Snapshot handed to `onProgress`. Counts are cumulative for one indexer run. */
export interface IndexProgress {
  /** Files newly inserted into `vault.fileMap` by THIS indexer. */
  files: number;
  /** Folders newly inserted into `vault.fileMap` by THIS indexer. */
  folders: number;
  /** True on the final emit (whether the pass completed, failed, or was cancelled). */
  done: boolean;
  /** True on the final emit when `cancel()` cut the pass short. */
  cancelled: boolean;
  /** True on the final emit when the pass aborted with an error. */
  failed: boolean;
}

/** Handed to `onComplete` when a pass finishes without being cancelled. */
export interface IndexComplete {
  /** True when the pass was the daemon's recursive `fs.walk` (real mtime/size). */
  viaFastPath: boolean;
  /** Files whose stat the walk found changed, updated with `modifyOne`. */
  modified: number;
  /** Paths the walk no longer found, dropped with `removeOne`. */
  removed: number;
  /** The walk covered the whole remote and the model was reconciled with it. */
  complete: boolean;
}

export interface BackgroundIndexerDeps {
  /** Fresh walker per walk — mirrors LazyFolderLoader and the connect populate. */
  makeWalker: () => BulkWalker;
  /** Fresh (stateless) builder per build. */
  makeBuilder: () => VaultModelBuilder;
  /**
   * Called with each folder path whose immediate children are now fully
   * materialised, so `LazyFolderLoader` skips re-walking it on a later
   * File-Explorer expand click.
   */
  markLoaded: (path: string) => void;
  /** Progress pump (status bar / notice). Always called at least once, with `done`. */
  onProgress?: (p: IndexProgress) => void;
  /**
   * The vault model when the pass starts. When given, a complete pass
   * RECONCILES the model against the walk as well as filling it in: it
   * updates files whose `mtime`/`size` changed and drops paths the remote no
   * longer has. Needed once the model can hold entries the remote may have
   * moved on from, i.e. ones restored from `TreeSnapshot` at startup.
   *
   * Only entries present at the start are ever changed or removed, so a note
   * created while the walk runs is never mistaken for one the remote lost.
   */
  modelAtStart?: () => RemoteEntry[];
  /**
   * The model's current stat for a file, or null. When given, a stat update is
   * skipped if the file changed after the pass started: a live `fs.watch`
   * event already has a newer stat than the walk.
   */
  currentStat?: (path: string) => { mtime: number; size: number } | null;
  /**
   * Paths the pass leaves alone: never added, updated or removed. For edits
   * still in the offline queue, where the model is ahead of the remote.
   */
  skip?: (path: string) => boolean;
  /** Paths the pass never removes, but still adds when they are missing. */
  keep?: (path: string) => boolean;
  /** Called once when a pass finishes without being cancelled. */
  onComplete?: (r: IndexComplete) => void;
  /**
   * Entries per `buildChunked` chunk. Deliberately SMALLER than the connect-time
   * populate's 500 — this runs while the user is working, so each synchronous
   * burst must stay short.
   */
  chunkSize?: number;
  /**
   * Yield between units of work. Defaults to `requestIdleCallback` (falling back
   * to a 0 ms timer). Injectable so tests can observe that we actually yield.
   */
  yieldFn?: () => Promise<void>;
}

/**
 * Indexes the WHOLE remote tree into `vault.fileMap`, in the background, after
 * the connect-time populate has already rendered the root level.
 *
 * ## Why this exists
 *
 * The lazy connect populate (`main.populateVaultFromRemote` with
 * `lazyFolderLoad`, the default) walks only the root's IMMEDIATE children, and
 * `LazyFolderLoader` deepens a folder only when the user CLICKS it open in File
 * Explorer. That keeps connect fast on a deep, dir-heavy vault — but everything
 * below depth 1 is then *absent from `vault.fileMap` entirely*, and Obsidian's
 * `metadataCache` resolves links only against `fileMap`. So a `[[link]]` into a
 * never-expanded subfolder does not resolve, an image embedded from one does not
 * render, and global search / quick switcher / graph / backlinks silently see a
 * partial vault. Registering the file is enough to fix all of those: once a path
 * lands in `fileMap`, Obsidian re-resolves the links pointing at it on its own.
 *
 * ## Shape
 *
 * - **Fast path** (daemon advertises `fs.walk`): ONE recursive walk. It is
 *   paginated server-side (one RPC per page), so the walk itself is cheap; the
 *   cost that used to freeze Obsidian was *materialising* the entries, which
 *   `buildChunked` already solves. Entries are fed depth-by-depth so a parent
 *   folder is always inserted in an earlier `buildChunked` call than its
 *   children, and so cancellation gets frequent, consistent cut points.
 * - **Fallback path** (SFTP / no daemon): breadth-first, ONE FOLDER AT A TIME.
 *   The fallback costs one `adapter.list` round-trip per directory, so a
 *   dir-heavy tree must trickle rather than stall — walk a folder, build it,
 *   mark it loaded, enqueue its subfolders, yield.
 *
 * Both paths are safe to race the click-driven `LazyFolderLoader` and the live
 * `FsChangeListener`: `VaultModelBuilder`'s inserts skip a path that is already
 * present, so a double-insert is a counted no-op, never a duplicate.
 *
 * File CONTENT is never read — only the tree. (Obsidian's own metadataCache
 * reads the files it cares about; that traffic is its call, not ours.)
 */
export class BackgroundIndexer {
  private cancelled = false;
  private failed = false;
  private running = false;
  private run: Promise<void> | null = null;
  private files = 0;
  private folders = 0;
  private lastLoggedAt = 0;

  /** Emit a `logger.info` progress line every this many newly-inserted entries. */
  private static readonly LOG_EVERY = 500;

  constructor(private readonly deps: BackgroundIndexerDeps) {}

  get isRunning(): boolean { return this.running; }
  get isCancelled(): boolean { return this.cancelled; }
  /** Entries this indexer has inserted so far. */
  get inserted(): { files: number; folders: number } {
    return { files: this.files, folders: this.folders };
  }

  /**
   * Kick off the pass. Returns a promise that settles when indexing finishes (or
   * is cancelled) — callers normally fire-and-forget it. Calling `start()` twice
   * returns the same in-flight run; a cancelled indexer is not restartable (build
   * a fresh one, as `main` does on reconnect).
   */
  start(): Promise<void> {
    if (this.run) return this.run;
    this.running = true;
    this.run = this.doRun().finally(() => { this.running = false; });
    return this.run;
  }

  /**
   * Stop as soon as the current unit of work finishes. Checked before every walk,
   * before every build, and between units, so an in-flight pass drops out within
   * one folder / one depth level.
   *
   * Folders whose children did not all land are left UNMARKED, so
   * `LazyFolderLoader` still deepens them on expand: a cancelled index degrades
   * back to exactly the lazy behaviour, never to a folder that claims to be
   * loaded but is empty.
   */
  cancel(): void {
    this.cancelled = true;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async doRun(): Promise<void> {
    const start = Date.now();
    try {
      const before = this.captureModelAtStart();
      const walker = this.deps.makeWalker();
      // What the walker CAN do, not what it did: `walk()` degrades to the
      // per-folder fallback on its own when the daemon's fs.walk throws, and
      // the pass below reports which path actually produced the entries.
      const result = walker.hasFastPath()
        ? await this.indexViaFullWalk(walker, before)
        : await this.indexBreadthFirst(before);
      if (result && !this.cancelled) this.deps.onComplete?.(result);
    } catch (e) {
      // A background index that dies must never take the session with it — the
      // vault just stays lazily loaded (i.e. the pre-existing behaviour).
      this.failed = true;
      logger.warn(`BackgroundIndexer: aborted (${errorMessage(e)}); vault stays lazily loaded`);
    } finally {
      logger.info(
        `BackgroundIndexer: ${this.cancelled ? 'cancelled' : 'complete'} — ` +
        `${this.files}f + ${this.folders}d indexed in ${Date.now() - start}ms`,
      );
      this.emit(true);
    }
  }

  /**
   * Daemon fast path: one paginated recursive `fs.walk`, then materialise the
   * result depth-by-depth. Folders are marked loaded only once the whole tree is
   * in, because this walk is all-or-nothing — marking mid-pass could mark a
   * folder whose children are still queued behind a later depth.
   */
  private async indexViaFullWalk(
    walker: BulkWalker,
    before: Map<string, RemoteEntry> | null,
  ): Promise<IndexComplete | null> {
    const walk = await walker.walk('', true);
    if (this.cancelled) return null;
    logger.info(
      `BackgroundIndexer: full walk — ${walk.entries.length} entries ` +
      `(${walk.hiddenCount} hidden) in ${walk.walkMs}ms (pages=${walk.pages})`,
    );
    const entries = this.unskipped(walk.entries);

    const byDepth = new Map<number, RemoteEntry[]>();
    for (const e of entries) {
      const bucket = byDepth.get(depthOf(e.path));
      if (bucket) bucket.push(e);
      else byDepth.set(depthOf(e.path), [e]);
    }

    const builder = this.deps.makeBuilder();
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      if (this.cancelled) return null;
      // buildChunked sorts folders-before-files within the call and yields
      // between chunks, so a same-depth file always finds its (same-call,
      // earlier) parent — and a deeper file finds its parent from the previous
      // depth's call.
      const result = await builder.buildChunked(byDepth.get(depth)!, this.chunkSize);
      this.files += result.filesAdded;
      this.folders += result.foldersAdded;
      this.emit(false);
      await this.yieldNow();
    }
    if (this.cancelled) return null;

    // Skipped folders too, as the fallback does: an unloaded one would be
    // re-listed on expand, without the skip filter.
    for (const e of walk.entries) {
      if (e.isDirectory) this.deps.markLoaded(e.path);
    }
    // The walk may have come back from the FALLBACK even though the daemon
    // advertises fs.walk — `walk()` degrades on its own when the RPC throws
    // partway through. Fallback entries carry mtime/size 0, so believing them
    // would zero every note's stat and then persist that as the snapshot.
    const viaFastPath = walk.source === 'rpc-walk';
    if (!viaFastPath) {
      logger.warn(
        `BackgroundIndexer: fs.walk degraded to the per-folder fallback ` +
        `(${walk.fastPathError ?? 'unknown'}); stats and removals skipped this pass`,
      );
    }
    // A truncated walk, or one that could not list every folder, is not the
    // whole remote: removing what it missed would delete notes that exist.
    const complete = viaFastPath && !walk.truncated && walk.listErrors === 0;
    if (!before) return { viaFastPath, modified: 0, removed: 0, complete: false };
    return {
      viaFastPath,
      complete,
      ...this.reconcile(builder, before, entries, {
        statUpdates: viaFastPath,
        removals: complete,
      }),
    };
  }

  /**
   * SFTP / no-daemon fallback: breadth-first, one folder per iteration. Each
   * folder costs one `adapter.list` round-trip, so we yield after every one and
   * mark it loaded as soon as its children are in — a dir-heavy tree trickles
   * into the model instead of stalling inside one unbounded traversal.
   *
   * Seeded with the root: re-walking it costs one list, and every entry it
   * returns is already in `fileMap` from the connect populate, so that first
   * rebuild is a pure (counted) skip.
   */
  private async indexBreadthFirst(before: Map<string, RemoteEntry> | null): Promise<IndexComplete | null> {
    const queue: string[] = [''];
    const seen = new Set<string>(queue);
    const walked: RemoteEntry[] = [];
    let failures = 0;
    while (queue.length > 0) {
      if (this.cancelled) return null;
      const folder = queue.shift()!;
      let walkResult: Awaited<ReturnType<BulkWalker['walk']>>;
      try {
        walkResult = await this.deps.makeWalker().walk(folder, false);
      } catch (e) {
        // One unreadable folder (permissions, vanished mid-walk) must not sink
        // the whole index. Left unmarked, so an expand click can still retry it.
        logger.warn(`BackgroundIndexer: walk "${folder}" failed (${errorMessage(e)}); skipping`);
        failures++;
        continue;
      }
      if (this.cancelled) return null;
      // The fallback swallows a folder it cannot list and returns an empty
      // set for it, which reads exactly like "that folder is empty". Only the
      // count tells them apart, and removals must not run without it.
      failures += walkResult.listErrors;
      const entries = this.unskipped(walkResult.entries);
      walked.push(...entries);

      const result = await this.deps.makeBuilder().buildChunked(entries, this.chunkSize);
      this.files += result.filesAdded;
      this.folders += result.foldersAdded;
      this.deps.markLoaded(folder);

      // Descend into skipped folders too: what lies under them is still
      // walked and reconciled, unless it is skipped in its own right.
      for (const e of walkResult.entries) {
        if (!e.isDirectory || seen.has(e.path)) continue;
        seen.add(e.path);
        queue.push(e.path);
      }
      this.emit(false);
      await this.yieldNow();
    }
    if (!before) return { viaFastPath: false, modified: 0, removed: 0, complete: false };
    // The fallback's entries carry mtime/size 0, so a stat comparison would call
    // every note changed. Removals only, and only if every folder was listed.
    return {
      viaFastPath: false,
      // Never: the fallback compares no stats, so remote edits stay stale.
      complete: false,
      ...this.reconcile(this.deps.makeBuilder(), before, walked, {
        statUpdates: false,
        removals: failures === 0,
      }),
    };
  }

  private unskipped(entries: readonly RemoteEntry[]): readonly RemoteEntry[] {
    const skip = this.deps.skip;
    return skip ? entries.filter((e) => !skip(e.path)) : entries;
  }

  /**
   * The model to reconcile against, or null to only fill in. Reconciling is an
   * extra: if reading the model fails, the pass still runs, as it did before.
   */
  private captureModelAtStart(): Map<string, RemoteEntry> | null {
    if (!this.deps.modelAtStart) return null;
    try {
      const keep = this.deps.keep;
      const model = this.unskipped(this.deps.modelAtStart());
      return byPath(keep ? model.filter((e) => !keep(e.path)) : model);
    } catch (e) {
      logger.warn(`BackgroundIndexer: can't read the model (${errorMessage(e)}); filling in only`);
      return null;
    }
  }

  private reconcile(
    builder: VaultModelBuilder,
    before: Map<string, RemoteEntry>,
    walked: readonly RemoteEntry[],
    opts: { statUpdates: boolean; removals: boolean },
  ): Reconciled {
    let modified = 0;
    let removed = 0;
    if (opts.statUpdates) {
      for (const e of walked) {
        if (e.isDirectory) continue;
        const was = before.get(e.path);
        if (!was || was.isDirectory) continue;
        // Compare ctime too: a restored snapshot can hold a stale one. Not
        // when the walk doesn't know it (0, an older daemon): that would fire
        // `modify` on every edited note at every reconnect.
        const sameCtime = e.ctime === 0 || was.ctime === e.ctime;
        if (was.mtime === e.mtime && was.size === e.size && sameCtime) continue;
        const now = this.deps.currentStat?.(e.path);
        if (now && (now.mtime !== was.mtime || now.size !== was.size)) continue;
        const ctime = e.ctime || was.ctime;
        if (builder.modifyOne(e.path, { ctime, mtime: e.mtime, size: e.size })) modified++;
      }
    }
    if (opts.removals) {
      const present = new Set(walked.map((e) => e.path));
      // Shallowest first: removing a folder takes its descendants with it, and
      // the later removeOne calls on those then find nothing and return false.
      const gone = [...before.values()]
        .filter((e) => !present.has(e.path))
        .sort((a, b) => depthOf(a.path) - depthOf(b.path));
      for (const e of gone) {
        if (builder.removeOne(e.path)) removed++;
      }
    }
    if (modified || removed) {
      logger.info(`BackgroundIndexer: reconciled — ${modified} changed, ${removed} removed`);
    }
    return { modified, removed };
  }

  private get chunkSize(): number {
    return this.deps.chunkSize ?? 100;
  }

  private emit(done: boolean): void {
    const total = this.files + this.folders;
    if (!done && total - this.lastLoggedAt >= BackgroundIndexer.LOG_EVERY) {
      this.lastLoggedAt = total;
      logger.info(`BackgroundIndexer: ${this.files}f + ${this.folders}d indexed so far…`);
    }
    this.deps.onProgress?.({
      files: this.files,
      folders: this.folders,
      done,
      cancelled: this.cancelled,
      failed: this.failed,
    });
  }

  private yieldNow(): Promise<void> {
    return this.deps.yieldFn ? this.deps.yieldFn() : idleYield();
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

type Reconciled = Pick<IndexComplete, 'modified' | 'removed'>;

function byPath(entries: readonly RemoteEntry[]): Map<string, RemoteEntry> {
  return new Map(entries.map((e) => [e.path, e]));
}

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
}

/**
 * Hand the main thread back between units of work. `requestIdleCallback` runs us
 * only when the renderer has slack (so typing and scrolling always win), with a
 * `timeout` so a permanently-busy renderer can't starve the index outright.
 * Electron/Obsidian ships it, but it isn't in the DOM lib's guaranteed surface
 * (and jsdom omits it), so we degrade to the same 0 ms macrotask yield
 * `VaultModelBuilder.buildChunked` uses.
 */
function idleYield(): Promise<void> {
  const ric = (window as unknown as IdleWindow).requestIdleCallback;
  if (typeof ric === 'function') {
    return new Promise<void>((resolve) => { ric(() => resolve(), { timeout: 500 }); });
  }
  return new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
}

function depthOf(path: string): number {
  let count = 0;
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '/') count++;
  }
  return count;
}
