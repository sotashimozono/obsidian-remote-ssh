export interface ReadCacheEntry {
  data: Buffer;
  /** Modification time in unix milliseconds, used to detect staleness against a fresh stat. */
  mtime: number;
  /** Cached byte size of `data`; precomputed so eviction does not have to recount. */
  byteSize: number;
}

export interface ReadCacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface ReadCacheOptions {
  /** Soft cap on the cumulative byte size of cached values. Default: 64 MiB. */
  maxBytes?: number;
}

/**
 * LRU + mtime-keyed file content cache.
 *
 * Policy:
 * - `put` overwrites the existing entry for a path.
 * - When the total bytes exceed `maxBytes`, the least-recently-used
 *   entries are evicted until the budget fits again.
 * - Staleness is the caller's responsibility: read fresh `mtime`
 *   from the remote (or from a bookkeeping channel like WatchPoller),
 *   compare with the entry returned by `peek`/`get`, and call
 *   `invalidate` when they diverge.
 */
export class ReadCache {
  private map = new Map<string, ReadCacheEntry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly maxBytes: number;

  constructor(options: ReadCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  }

  /** LRU read: marks the entry as most-recently-used and returns it. */
  get(path: string): ReadCacheEntry | null {
    const entry = this.map.get(path);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    // Re-insert to move to the most-recent position in the Map's iteration order.
    this.map.delete(path);
    this.map.set(path, entry);
    this.hits += 1;
    return entry;
  }

  /** Read without touching LRU order. Useful for staleness checks before a refresh. */
  peek(path: string): ReadCacheEntry | null {
    return this.map.get(path) ?? null;
  }

  has(path: string): boolean {
    return this.map.has(path);
  }

  put(path: string, data: Buffer, mtime: number): void {
    const existing = this.map.get(path);
    if (existing) {
      this.bytes -= existing.byteSize;
      this.map.delete(path);
    }
    const byteSize = data.byteLength;
    const entry: ReadCacheEntry = { data, mtime, byteSize };
    this.map.set(path, entry);
    this.bytes += byteSize;
    this.evictIfOverBudget();
  }

  invalidate(path: string): void {
    const existing = this.map.get(path);
    if (!existing) return;
    this.bytes -= existing.byteSize;
    this.map.delete(path);
  }

  /**
   * Evict every entry whose path is exactly `prefix` or starts with `prefix + "/"`.
   * Useful after a directory was renamed/deleted upstream.
   */
  invalidatePrefix(prefix: string): number {
    const slash = prefix.endsWith('/') ? prefix : prefix + '/';
    let removed = 0;
    for (const path of this.map.keys()) {
      if (path === prefix || path.startsWith(slash)) {
        const e = this.map.get(path)!;
        this.bytes -= e.byteSize;
        this.map.delete(path);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  stats(): ReadCacheStats {
    return {
      entries: this.map.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private evictIfOverBudget(): void {
    if (this.bytes <= this.maxBytes) return;
    // Map iteration order is insertion order; the oldest (least-recently-used) is first.
    const it = this.map.entries();
    while (this.bytes > this.maxBytes) {
      const next = it.next();
      if (next.done) break;
      const [path, entry] = next.value;
      this.bytes -= entry.byteSize;
      this.map.delete(path);
      this.evictions += 1;
    }
  }
}

