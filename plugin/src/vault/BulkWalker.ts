import type { ListedFiles } from 'obsidian';
import { logger } from '../util/logger';
import type { RemoteEntry } from './VaultModelBuilder';
import type { WalkParams, WalkResult, ServerInfo } from '../proto/types';

/**
 * The narrow slice of `app.vault.adapter` BulkWalker needs for its
 * fallback path. Matching the live adapter's surface so callers can
 * pass `app.vault.adapter` directly.
 */
export interface AdapterListSlice {
  list(normalizedPath: string): Promise<ListedFiles>;
}

/**
 * The slice of an established RPC connection BulkWalker needs to
 * decide whether the fast path is available and to drive it.
 */
export interface RpcConnectionSlice {
  rpc: { call(method: 'fs.walk', params: WalkParams): Promise<WalkResult> };
  info: Pick<ServerInfo, 'capabilities'>;
}

export interface BulkWalkerDeps {
  adapter: AdapterListSlice;
  /**
   * When set AND its `info.capabilities` advertises `fs.walk`, the
   * walker prefers a single RPC over the per-folder list loop. SFTP
   * sessions and pre-walk daemons leave this undefined.
   */
  rpcConnection?: RpcConnectionSlice;
  /**
   * Cap for the fast path's MaxEntries. Defaults to the daemon's own
   * default (50_000). Tests pass small values to exercise the
   * "truncated → fall back" branch without needing a real big vault.
   */
  maxEntries?: number;
}

/** Outcome telemetry from a single `walk()` call. */
export interface BulkWalkResult {
  entries: RemoteEntry[];
  /**
   * `'rpc-walk'` when the daemon's `fs.walk` produced the result;
   * `'fallback-list'` when we used the BFS-via-`adapter.list` path
   * (no RPC, daemon doesn't advertise the capability, RPC walk
   * threw, or it returned `truncated: true`).
   */
  source: 'rpc-walk' | 'fallback-list';
  /** Whether the fast-path response was truncated (only meaningful when source === 'rpc-walk'). */
  truncated: boolean;
  /** Wall-clock for the walk itself, milliseconds. */
  walkMs: number;
  /** When `fallback-list` because of a fast-path error, the error message; else null. */
  fastPathError: string | null;
}

/**
 * Walks a remote vault tree into a flat `RemoteEntry[]` ready for
 * `VaultModelBuilder.build`. Prefers the daemon's `fs.walk` (one RPC,
 * stat included) but transparently falls back to the legacy
 * BFS-via-`adapter.list` traversal when the fast path is unavailable
 * or unreliable.
 *
 * Fallback triggers (any one):
 *   - No RPC connection injected (= SFTP transport).
 *   - Daemon doesn't advertise `fs.walk` in its capabilities.
 *   - RPC call throws.
 *   - RPC returns `truncated: true` (= MaxEntries exhausted; partial
 *     data would mislead the vault model).
 *
 * The fallback's per-entry `mtime` / `size` stay at 0 (matching the
 * pre-walker behaviour) — Obsidian fills those in lazily on file
 * access. The fast path emits real values, which the model can use
 * straight away.
 */
export class BulkWalker {
  private static readonly FAST_PATH_CAPABILITY = 'fs.walk';

  constructor(private readonly deps: BulkWalkerDeps) {}

  async walk(rootPath: string = ''): Promise<BulkWalkResult> {
    const start = Date.now();
    if (this.canUseFastPath()) {
      try {
        const result = await this.fastPath(rootPath);
        if (!result.truncated) {
          return {
            ...result,
            walkMs: Date.now() - start,
            fastPathError: null,
          };
        }
        // Truncated → server returned a partial snapshot. We can't
        // hand a partial tree to VaultModelBuilder (it would silently
        // miss files), so fall back to the per-folder traversal which
        // doesn't have a budget.
        logger.warn(
          `BulkWalker: fs.walk returned truncated=true at ${result.entries.length} entries; ` +
          'falling back to per-folder list',
        );
        const fallback = await this.fallbackPath(rootPath);
        return {
          ...fallback,
          walkMs: Date.now() - start,
          fastPathError: 'truncated',
        };
      } catch (e) {
        const message = (e as Error).message;
        logger.warn(`BulkWalker: fs.walk failed (${message}); falling back to per-folder list`);
        const fallback = await this.fallbackPath(rootPath);
        return {
          ...fallback,
          walkMs: Date.now() - start,
          fastPathError: message,
        };
      }
    }

    const fallback = await this.fallbackPath(rootPath);
    return {
      ...fallback,
      walkMs: Date.now() - start,
      fastPathError: null,
    };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private canUseFastPath(): boolean {
    const conn = this.deps.rpcConnection;
    if (!conn) return false;
    return conn.info.capabilities.includes(BulkWalker.FAST_PATH_CAPABILITY);
  }

  private async fastPath(rootPath: string): Promise<{
    entries: RemoteEntry[];
    source: 'rpc-walk';
    truncated: boolean;
  }> {
    // canUseFastPath() guarded the caller, but assert for the type
    // narrowing flow analysis.
    if (!this.deps.rpcConnection) {
      throw new Error('BulkWalker.fastPath called without rpcConnection');
    }
    const params: WalkParams = { path: rootPath, recursive: true };
    if (this.deps.maxEntries != null) params.maxEntries = this.deps.maxEntries;
    const result = await this.deps.rpcConnection.rpc.call('fs.walk', params);

    const entries: RemoteEntry[] = result.entries.map(e => ({
      path:        e.path,
      isDirectory: e.type === 'folder',
      ctime:       e.mtime,  // daemon doesn't expose ctime separately; mtime is the closest signal
      mtime:       e.mtime,
      size:        e.size,
    }));
    return { entries, source: 'rpc-walk', truncated: result.truncated };
  }

  private async fallbackPath(rootPath: string): Promise<{
    entries: RemoteEntry[];
    source: 'fallback-list';
    truncated: false;
  }> {
    const entries: RemoteEntry[] = [];
    const queue: string[] = [rootPath];
    while (queue.length > 0) {
      const folder = queue.shift()!;
      let listing: ListedFiles;
      try {
        listing = await this.deps.adapter.list(folder);
      } catch (e) {
        logger.warn(`BulkWalker.fallbackPath: list("${folder}") failed: ${(e as Error).message}`);
        continue;
      }
      for (const sub of listing.folders) {
        if (!sub) continue;
        entries.push({ path: sub, isDirectory: true, ctime: 0, mtime: 0, size: 0 });
        queue.push(sub);
      }
      for (const file of listing.files) {
        if (!file) continue;
        entries.push({ path: file, isDirectory: false, ctime: 0, mtime: 0, size: 0 });
      }
    }
    return { entries, source: 'fallback-list', truncated: false };
  }
}
