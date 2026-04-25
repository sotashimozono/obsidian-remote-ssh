import type { RemoteEntry } from '../types';

interface DirCacheEntry {
  entries: RemoteEntry[];
  expiresAt: number;
}

export interface DirCacheOptions {
  /** TTL in milliseconds. Default: 3000 (3 seconds). */
  ttlMs?: number;
  /** Optional injection point for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Time-bounded cache of `list(path)` results. Designed to absorb bursts of
 * directory listings during the same render pass without serving stale
 * results across user-visible time scales. Combine with explicit
 * invalidation (e.g. after a write or rename) for correctness.
 */
export class DirCache {
  private map = new Map<string, DirCacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DirCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 3000;
    this.now = options.now ?? Date.now;
  }

  get(path: string): RemoteEntry[] | null {
    const entry = this.map.get(path);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(path);
      return null;
    }
    return entry.entries;
  }

  put(path: string, entries: RemoteEntry[]): void {
    this.map.set(path, {
      entries,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  invalidate(path: string): void {
    this.map.delete(path);
  }

  /** Drop entries for `prefix` and any descendant directory. */
  invalidatePrefix(prefix: string): number {
    const slash = prefix.endsWith('/') ? prefix : prefix + '/';
    let removed = 0;
    for (const path of this.map.keys()) {
      if (path === prefix || path.startsWith(slash)) {
        this.map.delete(path);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}
