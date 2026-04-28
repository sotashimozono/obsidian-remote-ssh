/**
 * One ancestor entry: the snapshot we recorded last time the user
 * read the file, so a 3-way merge has something to diff against.
 */
export interface AncestorEntry {
  /** UTF-8 content as the daemon (or SFTP wrapper) handed it to us. */
  content: string;
  /** Modification time (unix ms) the read returned. */
  mtime: number;
}

/**
 * Read snapshot store backing the 3-way merge UI. Whenever the
 * adapter serves a `read` / `readText` to the editor, we stash the
 * (path, content, mtime) here. When a subsequent write fails with
 * `PreconditionFailed`, the conflict modal pulls the ancestor out
 * to show three panes (ancestor, mine, remote-now) instead of the
 * blunt overwrite-or-cancel choice.
 *
 * Plain LRU on byte size — the maintainer's local memory is the
 * scarce resource, not the entry count. Per-session: cleared on
 * disconnect; never persisted to disk.
 *
 * Binary content is intentionally NOT tracked: a 3-way diff over
 * arbitrary bytes is not a useful UI. Binary conflicts continue
 * through the existing two-choice `WriteConflictModal`.
 */
export class AncestorTracker {
  /** Default soft cap on tracked content bytes. Matches `ReadCache`. */
  static readonly DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

  /** Eviction shrinks down to this fraction of `maxBytes` so a steady-state workload doesn't evict on every Put. */
  private static readonly EVICTION_TARGET = 0.9;

  private readonly entries = new Map<string, {
    content: string;
    mtime: number;
    sizeBytes: number;
    lastAccessed: number;
  }>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number = AncestorTracker.DEFAULT_MAX_BYTES) {}

  /**
   * Record (or refresh) the ancestor snapshot for `path`. Called from
   * the adapter's read paths and from successful writes (a fresh
   * write becomes the next read's ancestor).
   *
   * Re-remembering the same path replaces the existing entry — the
   * "ancestor" the user has in their editor is whatever they last
   * saw, which is what the latest read returned.
   */
  remember(path: string, content: string, mtime: number): void {
    const sizeBytes = byteLength(content);
    const existing = this.entries.get(path);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
    }
    this.entries.set(path, {
      content,
      mtime,
      sizeBytes,
      lastAccessed: nowTick(),
    });
    this.totalBytes += sizeBytes;
    if (this.totalBytes > this.maxBytes) {
      this.evict();
    }
  }

  /**
   * Return the recorded ancestor for `path`, or `null` if none. A hit
   * counts as access (LRU touch) so the entry survives a subsequent
   * eviction pass.
   */
  get(path: string): AncestorEntry | null {
    const e = this.entries.get(path);
    if (!e) return null;
    e.lastAccessed = nowTick();
    return { content: e.content, mtime: e.mtime };
  }

  /**
   * Drop the entry for `path`. Called on rename/remove so a stale
   * snapshot can't surface as the "ancestor" for a freshly created
   * file at the same path.
   */
  invalidate(path: string): void {
    const e = this.entries.get(path);
    if (!e) return;
    this.entries.delete(path);
    this.totalBytes -= e.sizeBytes;
  }

  /** Forget everything. Wired to disconnect / restoreAdapter. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Snapshot for diagnostics + tests. */
  stats(): { entries: number; bytes: number; maxBytes: number } {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
    };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /**
   * Drop oldest-by-lastAccessed entries until total bytes fall below
   * `EVICTION_TARGET × maxBytes`. The target leaves headroom so an
   * immediate follow-up `remember` doesn't re-trigger eviction.
   */
  private evict(): void {
    const target = Math.floor(this.maxBytes * AncestorTracker.EVICTION_TARGET);
    if (this.totalBytes <= target) return;

    const ordered = Array.from(this.entries.entries()).sort(
      (a, b) => a[1].lastAccessed - b[1].lastAccessed,
    );
    for (const [path, entry] of ordered) {
      if (this.totalBytes <= target) break;
      this.entries.delete(path);
      this.totalBytes -= entry.sizeBytes;
    }
  }
}

/**
 * UTF-8 byte length without paying for `Buffer.byteLength` — keeps
 * the module browser-/test-environment-portable. Each JS string char
 * is at most 4 UTF-8 bytes; we count surrogate pairs as one
 * 4-byte unit.
 */
function byteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate; the low surrogate that follows produces the
      // 4-byte rune together. Skip the low so we don't double-count.
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Monotonic counter for LRU ordering. Wall-clock time isn't suitable
 * here — back-to-back `remember`/`get` calls land in the same
 * millisecond, and a `Date.now()-based` discriminator would have to
 * mix in a tickCounter, which overflows JavaScript's safe-integer
 * range (`Date.now() * 1e6` is already > 2^53). A plain counter
 * gives a strict ordering that's all the eviction logic actually
 * needs.
 */
let tickCounter = 0;
function nowTick(): number {
  return ++tickCounter;
}
