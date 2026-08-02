import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/** What a materialised file looked like at the moment we wrote it. */
export interface MaterializedStat {
  size: number;
  mtimeMs: number;
}

/** Filesystem surface, injected so the budget/LRU logic tests without a disk. */
export interface MaterializedCacheDeps {
  /** Absolute path on the shadow disk for a vault-relative path. */
  absOf(rel: string): string;
  /** Create parents and write. Returns the resulting stat, or null on failure. */
  writeFile(abs: string, data: Buffer): MaterializedStat | null;
  /** Current stat of a local path; null when absent or not a regular file. */
  statFile(abs: string): MaterializedStat | null;
  /** Delete a local path. */
  deleteFile(abs: string): void;
  /**
   * Total bytes that may sit on the shadow disk as materialised copies.
   * A file bigger than this is never fetched at all.
   */
  budgetBytes: number;
  /** Per-file ceiling, so one huge attachment cannot consume the budget. */
  maxFileBytes: number;
}

/**
 * The bounded, on-demand disk cache behind `getFullPath` / `getFilePath`.
 *
 * ## The rule this encodes
 *
 * The remote vault is NOT cloned. The note tree stays virtual: a file
 * exists on the shadow disk only because something asked for a real
 * path to it (or read it through the vault API), and only while it fits
 * in the configured budget. Nothing is pre-fetched, and a file over the
 * budget is never fetched at all — not fetched and then discarded.
 *
 * ## Why eviction has to be careful
 *
 * A materialised copy sits in the same directory a plugin may write to,
 * and `LocalWriteWatcher` pushes what it finds there to the remote. Two
 * rules keep the two from fighting:
 *
 *  - **A copy we wrote is never pushed back.** The watcher asks
 *    {@link isMirroredCopy}; a file whose (size, mtime) still matches
 *    what we wrote is the remote's own bytes, not an edit.
 *  - **A locally modified copy is never evicted.** Its stat no longer
 *    matches the ledger, which means somebody changed it; deleting it
 *    would throw away an edit that has not been pushed yet. Such an
 *    entry is dropped from the ledger and left on disk — from then on
 *    it is an ordinary local file and the watcher owns it.
 */
export class MaterializedCache {
  /** rel → stat as written. Insertion order is the LRU order. */
  private readonly entries = new Map<string, MaterializedStat>();
  private total = 0;

  constructor(private readonly deps: MaterializedCacheDeps) {}

  /** Bytes currently accounted for by the ledger. */
  bytes(): number {
    return this.total;
  }

  /** Number of materialised files. */
  size(): number {
    return this.entries.size;
  }

  /** True when a payload would be refused for its size alone. */
  tooBig(byteLength: number): boolean {
    return byteLength > this.deps.maxFileBytes || byteLength > this.deps.budgetBytes;
  }

  /** True when the cache is switched off entirely (budget of zero). */
  disabled(): boolean {
    return this.deps.budgetBytes <= 0;
  }

  /**
   * Most bytes worth fetching for one file. Handed to the synchronous
   * fetch so an over-limit file is refused by the transport instead of
   * being pulled and then thrown away.
   */
  fetchLimit(): number {
    return Math.min(this.deps.maxFileBytes, this.deps.budgetBytes);
  }

  /**
   * Write `data` to the shadow disk and record it. Returns false when
   * the cache is disabled, the file is over a limit, or the write
   * fails — callers treat that as "not materialised" and carry on.
   */
  put(rel: string, data: Buffer): boolean {
    if (this.disabled()) return false;
    if (this.tooBig(data.byteLength)) {
      logger.info(
        `MaterializedCache: "${rel}" (${data.byteLength} bytes) exceeds the cache limit — ` +
        'not written to disk',
      );
      return false;
    }
    const abs = this.deps.absOf(rel);
    let stat: MaterializedStat | null;
    try {
      stat = this.deps.writeFile(abs, data);
    } catch (e) {
      logger.warn(`MaterializedCache: could not materialise "${rel}" (${errorMessage(e)})`);
      return false;
    }
    if (!stat) return false;
    this.forget(rel);
    this.entries.set(rel, stat);
    this.total += stat.size;
    this.evictDownToBudget();
    return this.entries.has(rel);
  }

  /** True when `rel` has a materialised copy that is still untouched. */
  has(rel: string): boolean {
    const known = this.entries.get(rel);
    if (!known) return false;
    const now = this.deps.statFile(this.deps.absOf(rel));
    if (!now) {
      this.forget(rel);
      return false;
    }
    if (now.size !== known.size || now.mtimeMs !== known.mtimeMs) {
      // Somebody edited our copy. It is theirs now.
      this.forget(rel);
      return false;
    }
    this.touch(rel, known);
    return true;
  }

  /**
   * The predicate `LocalWriteWatcher` consults before pushing: true
   * when the bytes on disk are the copy we put there, so pushing them
   * back to the remote would be an echo of the remote's own content.
   */
  isMirroredCopy(rel: string, stat: MaterializedStat): boolean {
    const known = this.entries.get(rel);
    if (!known) return false;
    return known.size === stat.size && known.mtimeMs === stat.mtimeMs;
  }

  /** Drop a path from the ledger without touching the disk. */
  forget(rel: string): void {
    const known = this.entries.get(rel);
    if (!known) return;
    this.entries.delete(rel);
    this.total -= known.size;
    if (this.total < 0) this.total = 0;
  }

  /**
   * Delete every materialised copy that is still untouched. Called on
   * disconnect: the cache is per-session, so nothing the user did not
   * put there themselves is left behind on the disk.
   */
  clear(): void {
    for (const rel of [...this.entries.keys()]) this.evictOne(rel);
    this.entries.clear();
    this.total = 0;
  }

  private touch(rel: string, stat: MaterializedStat): void {
    this.entries.delete(rel);
    this.entries.set(rel, stat);
  }

  private evictDownToBudget(): void {
    for (const rel of [...this.entries.keys()]) {
      if (this.total <= this.deps.budgetBytes) return;
      this.evictOne(rel);
    }
  }

  /**
   * Remove one entry. Deletes the file only when it still matches what
   * we wrote — a modified copy is abandoned to the watcher instead.
   */
  private evictOne(rel: string): void {
    const known = this.entries.get(rel);
    if (!known) return;
    const abs = this.deps.absOf(rel);
    const now = this.deps.statFile(abs);
    if (now && (now.size !== known.size || now.mtimeMs !== known.mtimeMs)) {
      logger.info(
        `MaterializedCache: "${rel}" changed on disk since it was materialised — ` +
        'left in place instead of evicted',
      );
      this.forget(rel);
      return;
    }
    try {
      this.deps.deleteFile(abs);
    } catch (e) {
      logger.warn(`MaterializedCache: could not evict "${rel}" (${errorMessage(e)})`);
    }
    this.forget(rel);
  }
}
