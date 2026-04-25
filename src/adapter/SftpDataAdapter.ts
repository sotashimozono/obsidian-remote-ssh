import type { ListedFiles, Stat } from 'obsidian';
import type { SftpClient } from '../ssh/SftpClient';
import type { ReadCache } from '../cache/ReadCache';
import type { DirCache } from '../cache/DirCache';
import { logger } from '../util/logger';

/**
 * Read-side implementation of Obsidian's `DataAdapter` over SFTP.
 *
 * Write methods (write/writeBinary/mkdir/remove/...) will be added in
 * Phase 4-G; this class is constructed in Phase 4-E and patched onto
 * `app.vault.adapter` in Phase 4-F.
 *
 * Path translation is currently a straight join of `remoteBasePath` and
 * the vault-relative `normalizedPath`. The per-client user-cache rewrite
 * (Phase 4-J0 / `PathMapper`) will be inserted at this boundary later.
 */
export class SftpDataAdapter {
  constructor(
    private client: SftpClient,
    /** Normalized remote base path (no trailing slash, no leading "~/"). */
    private remoteBasePath: string,
    private readCache: ReadCache,
    private dirCache: DirCache,
    private vaultName: string,
  ) {}

  // ─── DataAdapter (read-side) ─────────────────────────────────────────────

  getName(): string {
    return this.vaultName;
  }

  async exists(normalizedPath: string, _sensitive?: boolean): Promise<boolean> {
    return this.client.exists(this.toRemote(normalizedPath));
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    try {
      const s = await this.client.stat(this.toRemote(normalizedPath));
      return {
        type: s.isDirectory ? 'folder' : 'file',
        // SFTP only exposes mtime; reuse it as ctime so callers get a
        // monotonically reasonable value rather than 0.
        ctime: s.mtime,
        mtime: s.mtime,
        size: s.size,
      };
    } catch {
      return null;
    }
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    const remote = this.toRemote(normalizedPath);
    let entries = this.dirCache.get(remote);
    if (!entries) {
      entries = await this.client.list(remote);
      this.dirCache.put(remote, entries);
    }
    const files: string[] = [];
    const folders: string[] = [];
    const prefix = normalizedPath ? normalizedPath + '/' : '';
    for (const e of entries) {
      const childPath = prefix + e.name;
      if (e.isDirectory) folders.push(childPath);
      else files.push(childPath);
    }
    return { files, folders };
  }

  async read(normalizedPath: string): Promise<string> {
    const buf = await this.readBuffer(normalizedPath);
    return buf.toString('utf8');
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const buf = await this.readBuffer(normalizedPath);
    // Copy into a fresh ArrayBuffer so callers can't accidentally mutate
    // the cached Buffer's underlying memory through the returned view.
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return ab;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * Fetch (or revalidate) the file's contents.
   *
   * If the cache has an entry, stat the remote and reuse the cached buffer
   * when mtimes agree. Otherwise read the file, then opportunistically
   * stat it so the cache entry has a real mtime to compare against next
   * time. The opportunistic stat after a fresh read is best-effort: a
   * failure is logged but does not block the read result.
   */
  private async readBuffer(normalizedPath: string): Promise<Buffer> {
    const remote = this.toRemote(normalizedPath);
    const cached = this.readCache.peek(remote);

    if (cached) {
      try {
        const s = await this.client.stat(remote);
        if (s.mtime === cached.mtime) {
          this.readCache.get(remote); // bump LRU on hit
          return cached.data;
        }
        // Stale: refetch. We already have a fresh stat to record.
        const data = await this.client.readBinary(remote);
        this.readCache.put(remote, data, s.mtime);
        return data;
      } catch (e) {
        // Stat or refetch failed; surface the error.
        throw e;
      }
    }

    const data = await this.client.readBinary(remote);
    let mtime = 0;
    try {
      const s = await this.client.stat(remote);
      mtime = s.mtime;
    } catch (e) {
      logger.warn(`stat-after-read failed for "${remote}": ${(e as Error).message}`);
    }
    this.readCache.put(remote, data, mtime);
    return data;
  }

  toRemote(normalizedPath: string): string {
    if (!normalizedPath || normalizedPath === '/') return this.remoteBasePath;
    if (this.remoteBasePath === '') return normalizedPath;
    if (this.remoteBasePath === '/') return '/' + normalizedPath;
    return `${this.remoteBasePath}/${normalizedPath}`;
  }
}
