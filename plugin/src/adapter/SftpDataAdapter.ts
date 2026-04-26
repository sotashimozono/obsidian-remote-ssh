import type { DataWriteOptions, ListedFiles, Stat } from 'obsidian';
import type { RemoteFsClient } from './RemoteFsClient';
import type { ReadCache } from '../cache/ReadCache';
import type { DirCache } from '../cache/DirCache';
import type { PathMapper } from '../path/PathMapper';
import type { ResourceBridge } from './ResourceBridge';
import type { RemoteEntry } from '../types';
import { logger } from '../util/logger';

/**
 * Implementation of Obsidian's `DataAdapter` over a `RemoteFsClient`.
 *
 * The client can be either the direct-SFTP path (`SftpRemoteFsClient`
 * wrapping the existing `SftpClient`) or the α path
 * (`RpcRemoteFsClient` talking to `obsidian-remote-server`). The
 * adapter itself stays transport-agnostic.
 *
 * The class is constructed in Phase 4-E, patched onto
 * `app.vault.adapter` in Phase 4-F, and grew its write surface
 * (write/writeBinary/append/process/mkdir/remove/rmdir/rename/copy/
 * trashSystem/trashLocal) in Phase 4-G. Phase 5-D.2 flips the client
 * dependency from the concrete `SftpClient` to the narrow
 * `RemoteFsClient` interface.
 *
 * `getResourcePath` returns a `http://127.0.0.1:<port>/r/<token>?p=…`
 * URL served by an optional `ResourceBridge` (Phase 5-F). When no
 * bridge is wired the method falls back to a `data:` URL with no
 * payload, which Obsidian will fail to render — that's acceptable
 * because resource serving is a feature of the patched adapter, not
 * a hard requirement of the interface.
 *
 * Path translation is currently a straight join of `remoteBasePath`
 * and the vault-relative `normalizedPath`. The per-client user-cache
 * rewrite (Phase 4-J0 / `PathMapper`) will be inserted at this
 * boundary later.
 */
export class SftpDataAdapter {
  constructor(
    private client: RemoteFsClient,
    /** Normalized remote base path (no trailing slash, no leading "~/"). */
    private remoteBasePath: string,
    private readCache: ReadCache,
    private dirCache: DirCache,
    private vaultName: string,
    /**
     * Optional per-client path remapping. When supplied, paths matching
     * the mapper's "private" patterns (e.g. `.obsidian/workspace.json`)
     * are redirected into a per-client subtree on the remote so two
     * machines on the same vault don't clobber each other's UI state.
     * Phase 4-J0.
     */
    private pathMapper: PathMapper | null = null,
    /**
     * Optional localhost HTTP bridge that serves binary content to the
     * Obsidian webview. When supplied, `getResourcePath` returns a
     * bridge URL so `<img>`, `<iframe>`, `<audio>` etc. can render
     * remote-vault assets.
     */
    private resourceBridge: ResourceBridge | null = null,
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
    const plan = this.planList(normalizedPath);
    const primaryRemote = this.joinRemote(plan.primary);

    let primaryEntries = this.dirCache.get(primaryRemote);
    if (!primaryEntries) {
      primaryEntries = await this.client.list(primaryRemote);
      this.dirCache.put(primaryRemote, primaryEntries);
    }
    if (plan.hideUserDirName) {
      primaryEntries = primaryEntries.filter(e => e.name !== plan.hideUserDirName);
    }

    let userEntries: RemoteEntry[] = [];
    if (plan.mergeFromUser && plan.userSubtree) {
      const userRemote = this.joinRemote(plan.userSubtree);
      let cached = this.dirCache.get(userRemote);
      if (!cached) {
        try {
          cached = await this.client.list(userRemote);
          this.dirCache.put(userRemote, cached);
        } catch {
          // The per-client subtree doesn't exist yet — that's fine on
          // first connect, no entries to merge.
          cached = [];
        }
      }
      userEntries = cached;
    }

    const files: string[] = [];
    const folders: string[] = [];
    const prefix = normalizedPath ? normalizedPath + '/' : '';
    const seen = new Set<string>();
    const emit = (entry: RemoteEntry) => {
      if (seen.has(entry.name)) return;
      seen.add(entry.name);
      const childPath = prefix + entry.name;
      if (entry.isDirectory) folders.push(childPath);
      else files.push(childPath);
    };
    // The user-subtree entries take precedence — their names always
    // appear in the merged listing, even if a same-named placeholder
    // somehow exists in the primary listing.
    for (const e of userEntries) emit(e);
    for (const e of primaryEntries) emit(e);
    return { files, folders };
  }

  /**
   * Wrapper that lets the test suite see what the path mapper
   * decided about a given list request without going through a real
   * RemoteFsClient.
   */
  planList(normalizedPath: string): {
    primary: string;
    mergeFromUser: boolean;
    userSubtree?: string;
    hideUserDirName?: string;
  } {
    if (this.pathMapper) {
      return this.pathMapper.resolveListing(normalizedPath);
    }
    return { primary: normalizedPath, mergeFromUser: false };
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

  /**
   * URL the Obsidian webview should fetch to render this asset. If
   * the ResourceBridge is wired, the URL hits its localhost server
   * (which calls back into this adapter's `readBinary` for the bytes,
   * with all the cache + path-mapping logic intact). Without a bridge
   * we hand back an empty `data:` URL — the asset won't render, but
   * the read path is the only one that actually needs the bridge.
   */
  getResourcePath(normalizedPath: string): string {
    if (this.resourceBridge && this.resourceBridge.isRunning()) {
      return this.resourceBridge.urlFor(normalizedPath);
    }
    return 'data:application/octet-stream;base64,';
  }

  /**
   * Read a vault-relative binary asset and hand back a `Uint8Array`.
   * Wraps `readBinary` for the bridge's GET handler — ArrayBuffer ↔
   * Uint8Array is just a view, not a copy.
   */
  async fetchBinaryForBridge(normalizedPath: string): Promise<Uint8Array> {
    const ab = await this.readBinary(normalizedPath);
    return new Uint8Array(ab);
  }

  // ─── DataAdapter (write-side) ────────────────────────────────────────────

  async write(normalizedPath: string, data: string, _options?: DataWriteOptions): Promise<void> {
    await this.writeBuffer(normalizedPath, Buffer.from(data, 'utf8'));
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
    await this.writeBuffer(normalizedPath, Buffer.from(data));
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    let existing = '';
    try { existing = await this.read(normalizedPath); }
    catch { /* file did not exist; start empty so append acts like create */ }
    await this.write(normalizedPath, existing + data, options);
  }

  async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    let existing: Buffer;
    try { existing = await this.readBuffer(normalizedPath); }
    catch { existing = Buffer.alloc(0); }
    const merged = Buffer.concat([existing, Buffer.from(data)]);
    await this.writeBuffer(normalizedPath, merged);
    void options;
  }

  /**
   * Read, transform, and write back a plaintext file. Not atomic across
   * concurrent writers — same caveat as the underlying SFTP write (which
   * goes through a tmp+rename inside SftpClient).
   */
  async process(
    normalizedPath: string,
    fn: (data: string) => string,
    options?: DataWriteOptions,
  ): Promise<string> {
    const current = await this.read(normalizedPath);
    const next = fn(current);
    await this.write(normalizedPath, next, options);
    return next;
  }

  async mkdir(normalizedPath: string): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    await this.client.mkdirp(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
  }

  async remove(normalizedPath: string): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    await this.client.remove(remote);
    this.readCache.invalidate(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    await this.client.rmdir(remote, recursive);
    this.readCache.invalidatePrefix(remote);
    this.dirCache.invalidatePrefix(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldRemote = this.toRemote(oldPath);
    const newRemote = this.toRemote(newPath);
    await this.client.mkdirp(parentDirRemote(newRemote));
    await this.client.rename(oldRemote, newRemote);
    this.readCache.invalidatePrefix(oldRemote);
    this.readCache.invalidate(newRemote);
    this.dirCache.invalidatePrefix(oldRemote);
    this.dirCache.invalidate(parentDirRemote(oldRemote));
    this.dirCache.invalidate(parentDirRemote(newRemote));
  }

  async copy(oldPath: string, newPath: string): Promise<void> {
    const oldRemote = this.toRemote(oldPath);
    const newRemote = this.toRemote(newPath);
    await this.client.mkdirp(parentDirRemote(newRemote));
    await this.client.copy(oldRemote, newRemote);
    this.readCache.invalidate(newRemote);
    this.dirCache.invalidate(parentDirRemote(newRemote));
  }

  /**
   * SFTP has no concept of a system trash. Return false so Obsidian falls
   * through to its local-trash flow (`trashLocal`); we don't perform any
   * destructive action here.
   */
  async trashSystem(_normalizedPath: string): Promise<boolean> {
    return false;
  }

  /**
   * Move the path under `<vault>/.trash/`, mirroring Obsidian's local-trash
   * behaviour but on the remote. Existing files at the target are
   * overwritten; existing directories cause the rename to fail (that
   * matches the desktop behaviour).
   */
  async trashLocal(normalizedPath: string): Promise<void> {
    const trashedPath = '.trash/' + normalizedPath;
    await this.rename(normalizedPath, trashedPath);
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
        const data = await this.client.readBinary(remote);
        this.readCache.put(remote, data, s.mtime);
        return data;
      } catch (e) {
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

  /**
   * Atomic-on-the-server write through SftpClient (tmp+rename). Ensures
   * the parent directory exists, then refreshes the read cache with the
   * just-written content using the freshly-read mtime.
   */
  private async writeBuffer(normalizedPath: string, data: Buffer): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    const parent = parentDirRemote(remote);
    if (parent && parent !== remote) {
      await this.client.mkdirp(parent);
    }
    await this.client.writeBinary(remote, data);

    let mtime = 0;
    try {
      const s = await this.client.stat(remote);
      mtime = s.mtime;
    } catch (e) {
      logger.warn(`stat-after-write failed for "${remote}": ${(e as Error).message}`);
    }
    this.readCache.put(remote, data, mtime);
    this.dirCache.invalidate(parent);
  }

  /**
   * Drop cache entries for a path the daemon just reported as
   * changed via an `fs.changed` push. The argument is the daemon's
   * vault-relative path (already past PathMapper for private files);
   * the adapter joins it with `remoteBasePath` to recover the cache
   * key it actually stored under.
   */
  invalidateRemotePath(remoteVaultPath: string): void {
    const abs = this.joinRemote(remoteVaultPath);
    this.readCache.invalidate(abs);
    const parent = parentDirRemote(abs);
    if (parent) this.dirCache.invalidate(parent);
  }

  /**
   * Resolve a vault-relative path to the absolute path on the remote.
   *
   * If a PathMapper is attached, private vault paths are first
   * redirected into the per-client subtree (`.obsidian/workspace.json`
   * → `.obsidian/user/<id>/workspace.json`) so two machines on the
   * same vault don't trample each other's UI state. The mapped result
   * is then joined with `remoteBasePath` to form the full path the
   * `RemoteFsClient` sees.
   */
  toRemote(normalizedPath: string): string {
    const mapped = this.pathMapper
      ? this.pathMapper.toRemote(normalizedPath)
      : normalizedPath;
    return this.joinRemote(mapped);
  }

  private joinRemote(vaultRelative: string): string {
    if (!vaultRelative || vaultRelative === '/') return this.remoteBasePath;
    if (this.remoteBasePath === '') return vaultRelative;
    if (this.remoteBasePath === '/') return '/' + vaultRelative;
    return `${this.remoteBasePath}/${vaultRelative}`;
  }
}

/**
 * Parent directory of a remote path. Handles absolute (`/foo/bar` → `/foo`),
 * relative (`foo/bar` → `foo`), and edge cases (`/foo` → `/`, `foo` → ``,
 * `/` → `/`, `` → ``).
 */
function parentDirRemote(p: string): string {
  if (p === '' || p === '/') return p;
  const i = p.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return p.slice(0, i);
}
