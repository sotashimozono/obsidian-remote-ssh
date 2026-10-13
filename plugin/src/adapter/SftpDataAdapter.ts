import type { DataWriteOptions, ListedFiles, Stat } from 'obsidian';

/** The daemon's decoder set. webp / heic need cgo, so they pull the original. */
const THUMBNAIL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif']);

/**
 * Sharp on Retina without camera-original sizes — an 8 MB JPEG lands at
 * ~150 KB. Click-to-zoom goes through `readBinary`, which never hints a thumb.
 */
const DEFAULT_THUMB_MAX_DIM = 1024;

function isThumbnailEligible(vaultPath: string): boolean {
  const dot = vaultPath.lastIndexOf('.');
  if (dot < 0) return false;
  return THUMBNAIL_EXTENSIONS.has(vaultPath.slice(dot + 1).toLowerCase());
}
import * as fs from 'fs';
import * as nodePath from 'path';
import type { RemoteBinding } from '../ConnectionManager';
import type { RemoteFsClient } from './RemoteFsClient';
import type { WriterReflector, WrittenStat } from './WriterReflector';
import type { LocalOpRegistry } from './LocalOpRegistry';
import type { ReadCache } from '../cache/ReadCache';
import { ReconnectWait } from '../util/ReconnectWait';
import type { DirCache } from '../cache/DirCache';
import type { PathMapper } from '../path/PathMapper';
import type { ResourceBridge } from './ResourceBridge';
import type { RemoteEntry } from '../types';
import type { AncestorTracker } from '../conflict/AncestorTracker';
import type { ConflictResolver } from '../conflict/ConflictResolver';
import type { OfflineQueue, QueuedOp } from '../offline/OfflineQueue';
import type { TransferTracker } from '../util/TransferTracker';
import { logger } from '../util/logger';
import { perfTracer } from '../util/PerfTracer';
import { isPreconditionFailed } from '../proto/rpcError';
import { errorMessage } from "../util/errorMessage";

export type { ThreeWayPanes, TextConflictDecision } from '../conflict/ConflictResolver';

/**
 * Obsidian's `DataAdapter`, over a `RemoteFsClient`.
 *
 * The client is either the direct-SFTP path (`SftpRemoteFsClient` around
 * `SftpClient`) or the daemon (`RpcRemoteFsClient` talking to
 * `obsidian-remote-server`); the adapter itself stays transport-agnostic.
 *
 * Every vault-relative path goes through `PathMapper` — which redirects
 * per-client files into their own subtree — and is then joined onto
 * `remoteBasePath`. See {@link toRemote}.
 *
 * `getResourcePath` returns a `http://127.0.0.1:<port>/r/<token>?p=…` URL
 * served by an optional `ResourceBridge`. With no bridge it falls back to
 * an empty `data:` URL that Obsidian cannot render, which is acceptable:
 * serving binaries is a feature of the patched adapter, not part of the
 * interface it implements.
 */
export class SftpDataAdapter {
  constructor(
    private client: RemoteFsClient,
    /** Normalized remote base path (no trailing slash, no leading "~/"). */
    private remoteBasePath: string,
    private readCache: ReadCache,
    private dirCache: DirCache,
    private vaultName: string,
    /** Per-client path remapping; see {@link toRemote}. */
    private pathMapper: PathMapper | null = null,
    /** Serves binaries to the webview; see {@link getResourcePath}. */
    private resourceBridge: ResourceBridge | null = null,
    /**
     * Runs the merge or two-choice modal on `PreconditionFailed`. Without it,
     * a conflict surfaces as the raw `RpcError`.
     */
    private conflictResolver: ConflictResolver | null = null,
    /**
     * Every text read remembers `(content, mtime)` here, so a later conflict
     * has an ancestor to show as the third pane. Per-session, never persisted.
     */
    private ancestorTracker: AncestorTracker | null = null,
    /**
     * With it, a write during a reconnect succeeds synthetically — the editor
     * sees its own content through the read cache — and is drained on
     * recovery. Without it, such a write throws.
     */
    private offlineQueue: OfflineQueue | null = null,
    /**
     * The shadow vault's local root, surfaced by {@link basePath}. Production
     * captures it from the real `FileSystemAdapter` before patching; `''` is
     * for tests that never read it. Survey in PR #165, implementation #170.
     */
    private shadowBasePath: string = '',
    /** Registers payloads over 1 MB so the StatusBar can show progress (#127). */
    private transferTracker: TransferTracker | null = null,
    /**
     * Parks a read across a reconnect instead of failing it. Injectable so a
     * test can shorten the wait; production uses the defaults (see
     * ReconnectWait).
     */
    private reconnectWait: ReconnectWait = new ReconnectWait(),
  ) {}

  /**
   * `FileSystemAdapter.basePath`, so plugins that join paths against it
   * (Templater, Kanban, Importer, Copilot) get a real path instead of
   * `undefined` (#170).
   *
   * The vault tree is virtual, so raw `fs` here reaches only the local shadow
   * copy: reads miss remote notes and writes never leave the machine. Only
   * the vault API round-trips (#429).
   */
  get basePath(): string {
    return this.shadowBasePath;
  }

  /**
   * Mirror of `FileSystemAdapter.getBasePath()`. Equivalent to the
   * `basePath` getter; both are surveyed-as-used by community plugins
   * (#133, see `docs/en/user-guide/plugin-compatibility.md`).
   */
  getBasePath(): string {
    return this.shadowBasePath;
  }

  /**
   * Point the adapter at the remote as it now is.
   *
   * Takes the prefix as well as the client because a reconnect can change
   * transport — `ConnectionManager.reconnectAttempt` downgrades to SFTP when
   * the daemon turns out to be unavailable — and the two are one decision.
   *
   * This used to take only the client. A downgrade then left the adapter
   * joining paths with the RPC session's empty prefix, so every read and
   * write addressed the remote home instead of the vault inside it; the
   * reverse, SFTP→RPC, doubled the prefix.
   */
  rebind(binding: RemoteBinding): void {
    this.client = binding.client;
    this.remoteBasePath = binding.remoteBase;
    this.conflictResolver?.swapClient(binding.client);
  }

  /** True between the start of a reconnect loop and its terminal state. */
  private reconnecting = false;

  /**
   * Set once this adapter has been torn down (`AdapterManager.restore()`).
   *
   * Kept SEPARATE from `reconnecting` on purpose. Clearing `reconnecting` to
   * wake a parked read also tells `readBufferOverWire` the session is healthy,
   * and it would then put a real `stat`/`readBinary` on a transport that is
   * being abandoned — the reconnect-failed path calls `restore()` without
   * closing it. "Stop waiting" and "the connection is fine" are two different
   * facts and need two different flags.
   */
  private disposed = false;

  /**
   * Toggle the "reconnecting" gate. While set:
   *  - read / readBinary serve a cached value at once; on a miss they wait
   *    for the session (bounded — see ReconnectWait) and only then throw
   *  - list / stat / exists throw immediately, with no cache fallback
   *  - every write-side method throws a clear "reconnecting" notice
   *
   * Flipped on at the reconnect loop's start and off at recovered / failed /
   * cancelled. Only NEW calls are gated; calls already in flight hit the dead
   * transport and reject on their own.
   */
  setReconnecting(on: boolean): void {
    this.reconnecting = on;
  }

  /**
   * Retire this adapter: wake anything parked waiting for a reconnect, and
   * make every later read fail immediately instead of reaching for a
   * transport nobody owns any more.
   */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * Writer-side vault-model reflector (#341). When wired, every mutation
   * that lands on the remote is mirrored into this window's own
   * `vault.fileMap` and `vault.trigger(...)` bus, so File Explorer,
   * MetadataCache and open tabs follow a rename instead of staying bound to
   * a stale `TFile`.
   *
   * Wired on BOTH transports by `AdapterManager.wireLiveUpdates`. What stops
   * the daemon's echo of our own write firing a second time is not the
   * transport but {@link localOpRegistry}. Null until wired, and every
   * reflect is then a no-op.
   */
  private writerReflector: WriterReflector | null = null;

  setWriterReflector(reflector: WriterReflector | null): void {
    this.writerReflector = reflector;
  }

  /**
   * Echo-dedup registry (#341, RPC). When set, every applied local
   * mutation records its path(s) here so the RPC `FsChangeListener`
   * drops the daemon's `fs.watch` echo of our own op instead of
   * firing a second `vault.trigger`. Null on the SFTP transport
   * (no daemon, no echo) — recording is then a harmless no-op.
   */
  private localOpRegistry: LocalOpRegistry | null = null;

  setLocalOpRegistry(registry: LocalOpRegistry | null): void {
    this.localOpRegistry = registry;
  }

  /**
   * Run a writer-side reflect, swallowing and logging any throw.
   *
   * The remote op has already succeeded by the time this runs, so a fault in
   * the reflector must not reach the editor as a write failure — that would
   * provoke a retry and a duplicate remote write.
   *
   * The log carries the error's class name: a `TypeError` from a
   * model-builder defect and a transient listener fault need very different
   * triage, and they are indistinguishable without it.
   */
  private reflect(run: (r: WriterReflector) => void): void {
    const r = this.writerReflector;
    if (!r) return;
    try {
      run(r);
    } catch (e) {
      const kind = e instanceof Error ? e.name : typeof e;
      logger.warn(
        `SftpDataAdapter: writer reflect failed [${kind}]: ${errorMessage(e)}`,
      );
    }
  }

  /**
   * Record the paths, then reflect. The record is synchronous and must land
   * before the daemon's echo arrives, or the echo fires a second trigger.
   * Both steps are best-effort.
   *
   * `echoPaths` is what `fs.changed` will name — a rename echoes old and new,
   * possibly as separate events.
   */
  private applied(echoPaths: string[], run: (r: WriterReflector) => void): void {
    this.localOpRegistry?.record(echoPaths);
    this.reflect(run);
  }

  // ─── DataAdapter (read-side) ─────────────────────────────────────────────

  getName(): string {
    return this.vaultName;
  }

  async exists(normalizedPath: string, _sensitive?: boolean): Promise<boolean> {
    if (this.reconnecting) throw reconnectingError();
    return this.client.exists(this.toRemote(normalizedPath));
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    if (this.reconnecting) throw reconnectingError();
    try {
      const s = await this.client.stat(this.toRemote(normalizedPath));
      return {
        type: s.isDirectory ? 'folder' : 'file',
        // SFTP has no creation time; fall back to mtime.
        ctime: s.created ?? s.mtime,
        mtime: s.mtime,
        size: s.size,
      };
    } catch {
      return null;
    }
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    if (this.reconnecting) throw reconnectingError();
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
    const text = buf.toString('utf8');
    // Snapshot the just-read content so a subsequent conflicting write
    // can show the user a real ancestor pane in the 3-way modal.
    if (this.ancestorTracker) {
      const cached = this.readCache.peek(this.toRemote(normalizedPath));
      this.ancestorTracker.remember(normalizedPath, text, cached?.mtime ?? 0);
    }
    return text;
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
   * URL for the webview. The bridge's server calls back into `readBinary`, so
   * caching and path mapping stay intact. Without one the asset does not
   * render — only this method needs the bridge.
   */
  getResourcePath(normalizedPath: string): string {
    if (this.resourceBridge && this.resourceBridge.isRunning()) {
      // Image extensions get a thumbnail hint so the bridge can route
      // through the daemon's resize path. The bridge falls back to the
      // full binary transparently on SFTP sessions or pre-thumbnail
      // daemons, so this is safe regardless of transport.
      const thumbMaxDim = isThumbnailEligible(normalizedPath) ? DEFAULT_THUMB_MAX_DIM : undefined;
      return this.resourceBridge.urlFor(normalizedPath, { thumbMaxDim });
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
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        await this.queueOrThrowText(normalizedPath, data);
        return;
      }
      const written = await this.writeBuffer(normalizedPath, Buffer.from(data, 'utf8'), true);
      // After a successful text write, the file we just wrote IS the
      // new ancestor for any later edit cycle.
      if (this.ancestorTracker) {
        this.ancestorTracker.remember(normalizedPath, data, written?.mtime ?? 0);
      }
      this.applied([normalizedPath], r => r.reflectWrite(normalizedPath, written));
    } finally {
      perfTracer.end(__t1, { op: 'write', path: normalizedPath, bytes: data.length });
    }
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        await this.queueOrThrowBinary(normalizedPath, Buffer.from(data));
        return;
      }
      const written = await this.writeBuffer(normalizedPath, Buffer.from(data), false);
      this.applied([normalizedPath], r => r.reflectWrite(normalizedPath, written));
    } finally {
      perfTracer.end(__t1, { op: 'writeBinary', path: normalizedPath, bytes: data.byteLength });
    }
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        // Read through readBuffer, which serves a cached hit at once and
        // otherwise waits for the session (bounded — see ReconnectWait)
        // before giving up. Then splice and queue as a full write: reading
        // and writing as separate ops would explode the queue size when the
        // editor appends in a tight loop.
        let existing = '';
        try { existing = await this.read(normalizedPath); }
        catch { /* file did not exist; start empty so append acts like create */ }
        await this.queueOrThrowText(normalizedPath, existing + data);
        return;
      }
      let existing = '';
      try { existing = await this.read(normalizedPath); }
      catch { /* file did not exist; start empty so append acts like create */ }
      await this.write(normalizedPath, existing + data, options);
    } finally {
      perfTracer.end(__t1, { op: 'append', path: normalizedPath, bytes: data.length });
    }
  }

  async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        let existing: Buffer;
        try { existing = await this.readBuffer(normalizedPath); }
        catch { existing = Buffer.alloc(0); }
        const merged = Buffer.concat([existing, Buffer.from(data)]);
        await this.queueOrThrowBinary(normalizedPath, merged);
        return;
      }
      let existing: Buffer;
      try { existing = await this.readBuffer(normalizedPath); }
      catch { existing = Buffer.alloc(0); }
      const merged = Buffer.concat([existing, Buffer.from(data)]);
      const written = await this.writeBuffer(normalizedPath, merged, false);
      // appendBinary writes through writeBuffer directly (not via
      // this.write/writeBinary), so it must reflect itself or the
      // writer's model misses binary appends (#341).
      this.applied([normalizedPath], r => r.reflectWrite(normalizedPath, written));
      void options;
    } finally {
      perfTracer.end(__t1, { op: 'appendBinary', path: normalizedPath, bytes: data.byteLength });
    }
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
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        const current = await this.read(normalizedPath);
        const next = fn(current);
        await this.queueOrThrowText(normalizedPath, next);
        return next;
      }
      const current = await this.read(normalizedPath);
      const next = fn(current);
      await this.write(normalizedPath, next, options);
      return next;
    } finally {
      perfTracer.end(__t1, { op: 'process', path: normalizedPath });
    }
  }

  async mkdir(normalizedPath: string): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'mkdir', path: normalizedPath });
      return;
    }
    const remote = this.toRemote(normalizedPath);
    await this.client.mkdirp(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
    this.applied([normalizedPath], r => r.reflectMkdir(normalizedPath));
  }

  async remove(normalizedPath: string): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      const remote = this.toRemote(normalizedPath);
      if (this.reconnecting) {
        await this.queueOrThrowMutation({ kind: 'remove', path: normalizedPath });
      } else {
        await this.client.remove(remote);
      }
      this.invalidatePath(remote);
      this.ancestorTracker?.invalidate(normalizedPath);
      // Only when the delete actually hit the remote. While reconnecting it is
      // merely queued, so reflecting now would drop the entry locally while
      // the file still exists remotely — and a failed replay leaves them
      // diverged for good, since the replayer does not re-reflect.
      if (!this.reconnecting) this.applied([normalizedPath], r => r.reflectRemove(normalizedPath));
    } finally {
      perfTracer.end(__t1, { op: 'remove', path: normalizedPath });
    }
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'rmdir', path: normalizedPath, recursive });
    } else {
      await this.client.rmdir(remote, recursive);
      // AncestorTracker doesn't have prefix invalidation today; in
      // practice rmdir kills folders that the user wasn't editing as
      // text, so the stale entries (if any) just live until LRU pushes
      // them out. Cheap to add later if it ever matters.
    }
    this.invalidateTree(remote);
    // See `remove`: only mirror once the rmdir actually applied.
    if (!this.reconnecting) this.applied([normalizedPath], r => r.reflectRemove(normalizedPath));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      const oldRemote = this.toRemote(oldPath);
      const newRemote = this.toRemote(newPath);
      if (this.reconnecting) {
        await this.queueOrThrowMutation({ kind: 'rename', oldPath, newPath });
      } else {
        await this.client.mkdirp(parentDirRemote(newRemote));
        await this.client.rename(oldRemote, newRemote);
      }
      this.invalidateTree(oldRemote);
      this.invalidatePath(newRemote);
      // Keep the ancestor for `newPath` if one happens to exist (e.g.
      // rename onto an open file) — the user's edit cycle is against
      // whatever they last read at that path, regardless of how the
      // file got there.
      this.ancestorTracker?.invalidate(oldPath);
      // See `remove`: only mirror once the rename actually applied.
      // Echo both paths — some watchers split a rename into
      // delete(old) + create(new).
      if (!this.reconnecting) this.applied([oldPath, newPath], r => r.reflectRename(oldPath, newPath));
    } finally {
      perfTracer.end(__t1, { op: 'rename', path: oldPath, newPath });
    }
  }

  async copy(oldPath: string, newPath: string): Promise<void> {
    const newRemote = this.toRemote(newPath);
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'copy', srcPath: oldPath, dstPath: newPath });
    } else {
      const oldRemote = this.toRemote(oldPath);
      await this.client.mkdirp(parentDirRemote(newRemote));
      await this.client.copy(oldRemote, newRemote);
    }
    this.invalidatePath(newRemote);
  }

  /**
   * SFTP has no concept of a system trash. Return false so Obsidian falls
   * through to its local-trash flow (`trashLocal`); we don't perform any
   * destructive action here.
   */
  trashSystem(_normalizedPath: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Obsidian's local-trash behaviour, on the remote. A file at the target is
   * overwritten; a directory makes the rename fail, as on the desktop.
   */
  async trashLocal(normalizedPath: string): Promise<void> {
    // Implemented as a rename under .trash/; the rename method
    // already handles the reconnecting → queue path on its own, so we
    // just delegate.
    const trashedPath = '.trash/' + normalizedPath;
    await this.rename(normalizedPath, trashedPath);
  }

  // ─── internals ───────────────────────────────────────────────────────────

  // ─── offline queue replay (E2-β.3) ─────────────────────────────────────

  /**
   * Drive a single queued op against the live remote. Used by
   * `QueueReplayer` once the SSH session has recovered. Differs from
   * the regular write path in that it honours the queued op's
   * `expectedMtime` (= the mtime the file had when the user started
   * typing) rather than whatever the cache currently holds.
   *
   * Outcomes:
   *
   *   - `ok` — the op landed cleanly (or the user picked
   *     `keep-mine` / `merged` in the 3-way modal).
   *   - `conflict` — the user cancelled the conflict modal or chose
   *     `keep-theirs`; the op should be considered NOT-fulfilled,
   *     but the queue entry can still be marked completed because
   *     the user has actively decided not to apply it.
   *   - `error` — anything else (network, permission, etc.). The
   *     queue entry stays pending so the next reconnect can retry.
   */
  async replayQueuedOp(op: QueuedOp): Promise<{ result: 'ok' } | { result: 'conflict' } | { result: 'error'; message: string }> {
    if (this.reconnecting) {
      return { result: 'error', message: 'replayQueuedOp called while reconnecting' };
    }
    try {
      switch (op.kind) {
        case 'write': {
          const data = Buffer.from(op.contentBase64, 'base64');
          await this.writeBuffer(op.path, data, true, op.expectedMtime);
          return { result: 'ok' };
        }
        case 'writeBinary': {
          const data = Buffer.from(op.contentBase64, 'base64');
          await this.writeBuffer(op.path, data, false, op.expectedMtime);
          return { result: 'ok' };
        }
        case 'append': {
          const data = Buffer.from(op.contentBase64, 'base64').toString('utf8');
          await this.append(op.path, data);
          return { result: 'ok' };
        }
        case 'appendBinary': {
          const data = Buffer.from(op.contentBase64, 'base64');
          const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          await this.appendBinary(op.path, ab);
          return { result: 'ok' };
        }
        case 'mkdir':
          await this.mkdir(op.path);
          return { result: 'ok' };
        case 'remove':
          await this.remove(op.path);
          return { result: 'ok' };
        case 'rmdir':
          await this.rmdir(op.path, op.recursive);
          return { result: 'ok' };
        case 'rename':
          await this.rename(op.oldPath, op.newPath);
          return { result: 'ok' };
        case 'copy':
          await this.copy(op.srcPath, op.dstPath);
          return { result: 'ok' };
        case 'trashLocal':
          await this.trashLocal(op.path);
          return { result: 'ok' };
      }
    } catch (e) {
      const msg = errorMessage(e);
      // The 3-way merge path's `cancel` and `keep-theirs` branches
      // rethrow the original PreconditionFailed; treat that as a
      // user-driven decision rather than an error so the queue can
      // mark the entry done and move on.
      if (isPreconditionFailed(e)) {
        return { result: 'conflict' };
      }
      return { result: 'error', message: msg };
    }
  }

  // ─── offline queue helpers (E2-β) ──────────────────────────────────────

  /**
   * Queue the write and refresh local caches so the editor sees its own
   * content. Throws when no queue is wired.
   *
   * The op carries the mtime the file had when the user started typing, so a
   * conflict during replay can still reach the merge UI.
   *
   * The ancestor tracker is deliberately NOT refreshed: it holds what the
   * user actually read. Refreshing it would show them (mine, mine, theirs).
   */
  private async queueOrThrowText(normalizedPath: string, data: string): Promise<void> {
    if (!this.offlineQueue) throw reconnectingError();
    const remote = this.toRemote(normalizedPath);
    const cached = this.readCache.peek(remote);
    const buf = Buffer.from(data, 'utf8');
    await this.offlineQueue.enqueue({
      kind: 'write',
      path: normalizedPath,
      contentBase64: buf.toString('base64'),
      expectedMtime: cached?.mtime,
    });
    const synthMtime = Date.now();
    this.readCache.put(remote, buf, synthMtime);
  }

  /** Binary equivalent of `queueOrThrowText`; the ancestor tracker is text-only so it's left alone. */
  private async queueOrThrowBinary(normalizedPath: string, buf: Buffer): Promise<void> {
    if (!this.offlineQueue) throw reconnectingError();
    const remote = this.toRemote(normalizedPath);
    const cached = this.readCache.peek(remote);
    await this.offlineQueue.enqueue({
      kind: 'writeBinary',
      path: normalizedPath,
      contentBase64: buf.toString('base64'),
      expectedMtime: cached?.mtime,
    });
    const synthMtime = Date.now();
    this.readCache.put(remote, buf, synthMtime);
  }

  /**
   * Append a non-write mutation (mkdir / remove / rmdir / rename /
   * copy) to the offline queue. Cache invalidation lives in each
   * caller because the right invalidation differs by op shape.
   */
  private async queueOrThrowMutation(op: QueuedOp): Promise<void> {
    if (!this.offlineQueue) throw reconnectingError();
    await this.offlineQueue.enqueue(op);
  }

  /**
   * Fetch or revalidate. A cached entry is reused when the remote stat agrees;
   * otherwise the file is read and then stat'd so the next comparison has a
   * real mtime. That trailing stat is best-effort and never blocks the read.
   */
  private async readBuffer(normalizedPath: string): Promise<Buffer> {
    const remote = this.toRemote(normalizedPath);

    // A cached hit needs no session at all, so serve it without waiting on
    // the reconnect below.
    if (this.reconnecting) {
      const cachedNow = this.readCache.peek(remote);
      if (cachedNow) {
        this.readCache.get(remote); // bump LRU on hit
        return cachedNow.data;
      }
    }

    // Everything past here talks to the remote. A read that lands while the
    // session is reconnecting waits for it rather than failing: Obsidian's
    // indexer never retries, so a "reconnecting" error is a note left with
    // no metadata and nothing said about it — 9,756 of them in the 50,000
    // note run (#513). The wait is bounded; if the session is still down
    // afterwards, readBufferOverWire fails as it always did.
    await this.reconnectWait.wait(() => this.reconnecting && !this.disposed);
    return this.readBufferOverWire(remote, normalizedPath);
  }

  private async readBufferOverWire(remote: string, normalizedPath: string): Promise<Buffer> {
    const cached = this.readCache.peek(remote);

    // Still reconnecting after the wait, or retired while we waited: serve
    // the cache if we can, and only then give up. Reaching the wire past this
    // point would mean talking to a transport that is gone.
    if (this.reconnecting || this.disposed) {
      if (cached) {
        this.readCache.get(remote); // bump LRU on hit
        return cached.data;
      }
      throw this.disposed ? disconnectedError() : reconnectingError();
    }

    if (cached) {
      const s = await this.client.stat(remote);
      // Revalidate on mtime AND size. mtime alone is not enough: SFTP reports
      // it at 1-second resolution (`SftpClient`: `mtime: stats.mtime * 1000`),
      // so two edits inside the same wall-clock second collapse onto the same
      // value — and we would serve a cached copy of a file that no longer
      // exists on the server, then let the user save it back over the real one.
      // `stat` already hands us the size (it is used just below to size the
      // transfer), so comparing it costs nothing and catches every same-second
      // edit that changed the length.
      //
      // Not a theoretical race: `reflect.spec.ts` sleeps 1.1 s between remote
      // edits to keep itself green — this bug wearing a workaround. Pinned by
      // `e2e/cache-pressure.spec.ts`.
      //
      // A same-second edit that preserves the byte length is still invisible
      // here; closing that needs a content hash or a server-side change
      // counter. This removes the common case, cheaply.
      const sizeMatches = s.size === undefined || s.size === cached.data.byteLength;
      if (s.mtime === cached.mtime && sizeMatches) {
        this.readCache.get(remote); // bump LRU on hit
        return cached.data;
      }
      // Stat tells us the size so we can register a tracked download
      // before paying the bandwidth.
      const txId = this.transferTracker?.begin('down', normalizedPath, s.size ?? 0) ?? null;
      try {
        const data = await this.client.readBinary(remote);
        this.readCache.put(remote, data, s.mtime);
        return data;
      } finally {
        this.transferTracker?.end(txId);
      }
    }

    const data = await this.client.readBinary(remote);
    let mtime = 0;
    try {
      const s = await this.client.stat(remote);
      mtime = s.mtime;
    } catch (e) {
      logger.warn(`stat-after-read failed for "${remote}": ${errorMessage(e)}`);
    }
    this.readCache.put(remote, data, mtime);
    return data;
  }

  /**
   * Mirror a successful `<configDir>/**` write onto the LOCAL shadow disk
   * (#342 / #429 — "plugin settings are not kept after restarting the vault").
   *
   * A pull on connect cannot replace this. Obsidian loads community plugins
   * during startup and each `onload()` calls `Plugin.loadData()`, reading
   * `<configDir>/plugins/<id>/data.json` BEFORE remote-ssh has connected and
   * patched the adapter — so that read always hits the real
   * `FileSystemAdapter`, i.e. local disk. The connect is async, at
   * layout-ready; there is no getting in front of it.
   *
   * Nothing used to write local disk at all: `saveData()` went through the
   * patched adapter straight to the remote, the local copy stayed empty,
   * every restart booted the plugin on DEFAULTS — and the plugin then saved
   * those back, destroying the real settings on the remote too.
   *
   * So local disk is kept as a warm cache and the remote per-device copy
   * stays the source of truth. `<configDir>/**` only: the note tree stays
   * virtual, and mirroring it would defeat the shadow vault entirely.
   * Best-effort — a failure here must not fail the write that already landed.
   */
  private writeThroughConfig(normalizedPath: string, data: Buffer): void {
    if (!this.shadowBasePath || !this.pathMapper) return;
    const rel = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
    if (!rel.startsWith(`${this.pathMapper.configDir}/`)) return;

    // Containment must be checked on the RESOLVED path, not the raw string:
    // the prefix test above is a plain `startsWith`, so `.obsidian/x/../../../
    // evil` would sail past it and `join` would then resolve the `..` right
    // out of the shadow root. `resolve` also collapses win32 backslashes,
    // which would otherwise be a second way to smuggle a separator through.
    // The vault path reaches us from Obsidian / other plugins — not trusted.
    const root = nodePath.resolve(this.shadowBasePath);
    const abs = nodePath.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + nodePath.sep)) {
      logger.warn(`writeThroughConfig: refusing to mirror outside the shadow root: "${rel}"`);
      return;
    }

    try {
      // NEVER write through a symlink. `ShadowVaultBootstrap.installPlugin`
      // symlinks remote-ssh's OWN main.js / manifest.json / styles.css in the
      // shadow vault back to the SOURCE vault's real files, and
      // `fs.writeFileSync` follows symlinks — mirroring one would overwrite
      // the source vault's plugin install and brick it. That is exactly the
      // bug class #455 just fixed; do not reintroduce it here.
      //
      // Skipping costs nothing: the remote write already succeeded, and for
      // plugin CODE the local copy is owned by the pull/push binary
      // round-trip (`PLUGIN_BINARY_FILES`), not by this cache.
      if (fs.lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) {
        logger.warn(`writeThroughConfig: "${rel}" is a symlink — not mirrored (would clobber its target)`);
        return;
      }
      // Same hazard one level up: a symlinked ANCESTOR (e.g. a stale
      // whole-dir plugin symlink from an older build) would redirect the
      // write out of the shadow root even though `abs` looked contained.
      const dir = nodePath.dirname(abs);
      const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : null;
      if (realDir && realDir !== root && !realDir.startsWith(root + nodePath.sep)) {
        logger.warn(`writeThroughConfig: "${rel}" resolves outside the shadow root via a symlinked parent — not mirrored`);
        return;
      }

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(abs, data);
    } catch (e) {
      // The remote write already succeeded — the session is correct either
      // way; only the next restart's warm start is degraded.
      logger.warn(`writeThroughConfig: "${rel}" not mirrored locally (${errorMessage(e)})`);
    }
  }

  /**
   * Atomic-on-the-server write (tmp+rename): ensure the parent exists, write,
   * then refresh the read cache with the freshly-read mtime. Returns that
   * stat, or undefined if it failed.
   *
   * A recent ReadCache entry supplies `expectedMtime`, so the server rejects
   * the write if another client got there first. On rejection:
   *
   *   1. If `isText` AND we have an ancestor snapshot AND a 3-way
   *      callback, present `(ancestor, mine, theirs)` to the user.
   *      Their decision either clobbers, replaces with theirs,
   *      writes a hand-merged version, or cancels.
   *   2. Else, fall back to the legacy `onWriteConflict` (overwrite
   *      or cancel) — used by binary writes and by text writes that
   *      have no ancestor (e.g. write-without-prior-read).
   *   3. Else, rethrow the precondition error.
   *
   * `data` is reassigned in the merge branch so the cache update afterwards
   * reflects what actually landed.
   *
   * `expectedMtimeOverride` is for the offline-queue replayer: it feeds the
   * mtime captured at ENQUEUE time, not whatever the cache holds now — which
   * by then is the synthetic mtime the offline write put there.
   */
  private async writeBuffer(
    normalizedPath: string,
    data: Buffer,
    isText: boolean,
    expectedMtimeOverride?: number,
  ): Promise<WrittenStat | undefined> {
    const remote = this.toRemote(normalizedPath);
    const parent = parentDirRemote(remote);
    if (parent && parent !== remote) {
      await this.client.mkdirp(parent);
    }

    const cached = this.readCache.peek(remote);
    const expectedMtime = expectedMtimeOverride ?? cached?.mtime;
    let writtenData = data;
    const txId = this.transferTracker?.begin('up', normalizedPath, data.length) ?? null;
    try {
      try {
        await this.client.writeBinary(remote, writtenData, expectedMtime);
      } catch (e) {
        if (expectedMtime === undefined || !isPreconditionFailed(e) || !this.conflictResolver) {
          throw e;
        }
        writtenData = await this.conflictResolver.resolve(
          normalizedPath, remote, writtenData, isText, e,
        );
      }
    } finally {
      this.transferTracker?.end(txId);
    }

    // The remote now holds `writtenData`. Mirror it onto the local shadow
    // disk too, so the next Obsidian start reads the real settings (#342/#429).
    this.writeThroughConfig(normalizedPath, writtenData);

    let written: WrittenStat | undefined;
    try {
      const s = await this.client.stat(remote);
      written = { ctime: s.created, mtime: s.mtime, size: s.size };
    } catch (e) {
      logger.warn(`stat-after-write failed for "${remote}": ${errorMessage(e)}`);
    }
    this.readCache.put(remote, writtenData, written?.mtime ?? 0);
    this.dirCache.invalidate(parent);
    return written;
  }


  /**
   * Drop caches for a path the daemon reported changed. The argument is
   * already past PathMapper, so only `remoteBasePath` is joined back on to
   * recover the key this adapter stored under.
   */
  invalidateRemotePath(remoteVaultPath: string): void {
    this.invalidatePath(this.joinRemote(remoteVaultPath));
  }

  /**
   * Vault-relative to remote-absolute. Private paths are redirected into the
   * per-client subtree first (`.obsidian/workspace.json` →
   * `.obsidian/user/<id>/workspace.json`), so two machines on one vault do
   * not trample each other's UI state; the result is joined onto
   * `remoteBasePath`.
   */
  toRemote(normalizedPath: string): string {
    const mapped = this.pathMapper
      ? this.pathMapper.toRemote(normalizedPath)
      : normalizedPath;
    return this.joinRemote(mapped);
  }

  /** Invalidate read + dir caches for a single remote path. */
  private invalidatePath(remote: string): void {
    this.readCache.invalidate(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
  }

  /** Prefix-invalidate read + dir caches for a remote subtree. */
  private invalidateTree(remote: string): void {
    this.readCache.invalidatePrefix(remote);
    this.dirCache.invalidatePrefix(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
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

/**
 * One error for "temporarily unavailable", distinct from not-found and
 * permission-denied, so the editor can say something useful instead of
 * reporting a generic IO failure.
 */
function reconnectingError(): Error {
  return new Error('Remote SSH: reconnecting — try again once the connection is restored');
}

function disconnectedError(): Error {
  return new Error('Remote SSH: the connection was closed — reconnect to read this file');
}

