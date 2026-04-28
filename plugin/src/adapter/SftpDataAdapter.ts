import type { DataWriteOptions, ListedFiles, Stat } from 'obsidian';

/**
 * Source extensions whose `getResourcePath` hits the daemon's
 * `fs.thumbnail` path instead of pulling the full original. Matches
 * the daemon's supported decoder set (jpg / png / gif via image.Decode);
 * webp / heic land later (cgo / external libs).
 */
const THUMBNAIL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif']);

/**
 * Default longer-side cap for `getResourcePath` thumbnails. 1024 px
 * is sharp on Retina displays without sending camera-original sizes;
 * a 8 MB JPEG resizes to ~150 KB. Click-to-zoom flows that want the
 * original go through `readBinary`, which never adds the thumb hint.
 */
const DEFAULT_THUMB_MAX_DIM = 1024;

function isThumbnailEligible(vaultPath: string): boolean {
  const dot = vaultPath.lastIndexOf('.');
  if (dot < 0) return false;
  return THUMBNAIL_EXTENSIONS.has(vaultPath.slice(dot + 1).toLowerCase());
}
import type { RemoteFsClient } from './RemoteFsClient';
import type { ReadCache } from '../cache/ReadCache';
import type { DirCache } from '../cache/DirCache';
import type { PathMapper } from '../path/PathMapper';
import type { ResourceBridge } from './ResourceBridge';
import type { RemoteEntry } from '../types';
import type { AncestorTracker } from '../conflict/AncestorTracker';
import type { OfflineQueue, QueuedOp } from '../offline/OfflineQueue';
import { logger } from '../util/logger';

/**
 * Inputs to a 3-way conflict prompt. The adapter assembles these
 * before calling `onTextConflict`: ancestor is what the user had
 * loaded (from `AncestorTracker`), mine is what they're trying to
 * write, theirs is what the remote currently holds (re-read after
 * the precondition failure).
 */
export interface ThreeWayPanes {
  ancestor: string;
  mine: string;
  theirs: string;
}

/**
 * Outcome of a `onTextConflict` prompt. Mirrors the modal's
 * `ThreeWayDecision` shape; keeping this as a separate type so the
 * adapter doesn't depend on the obsidian-tied UI module.
 */
export type TextConflictDecision =
  | { decision: 'keep-mine' }
  | { decision: 'keep-theirs' }
  | { decision: 'merged'; content: string }
  | { decision: 'cancel' };

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
    /**
     * Optional callback invoked when a write fails with
     * `PreconditionFailed`. Returning `true` makes the adapter retry
     * without `expectedMtime` (the user chose to overwrite the
     * remote); `false` re-throws the original error so the caller
     * sees a normal failure.
     *
     * When omitted (e.g. unit tests), conflicts are surfaced as the
     * underlying `RpcError` and the editor decides what to do.
     *
     * Used as the binary-write fallback when the 3-way merge path
     * isn't available (no ancestor / no `onTextConflict` callback).
     */
    private onWriteConflict: ((vaultPath: string) => Promise<boolean>) | null = null,
    /**
     * Optional snapshot store: every text read remembers its
     * (content, mtime) here, and a subsequent `PreconditionFailed`
     * write pulls the ancestor out so the 3-way merge UI has all
     * three panes to show. Per-session, never persisted.
     */
    private ancestorTracker: AncestorTracker | null = null,
    /**
     * Optional callback for text-write conflicts. When supplied AND
     * an ancestor snapshot exists for the conflicting path, the
     * adapter routes through here instead of `onWriteConflict` —
     * giving the caller (the modal) all three panes to render.
     */
    private onTextConflict:
      | ((vaultPath: string, panes: ThreeWayPanes) => Promise<TextConflictDecision>)
      | null = null,
    /**
     * Optional persistent queue. When supplied, write-side calls that
     * land while `setReconnecting(true)` succeed synthetically (the
     * editor sees the new content via the local read cache) and the
     * op is appended to the queue. The replayer (E2-β.3) drains the
     * queue when the session recovers. When omitted, writes during
     * reconnect throw — the legacy behaviour.
     */
    private offlineQueue: OfflineQueue | null = null,
  ) {}

  /**
   * Swap the underlying transport while the adapter stays patched
   * onto `app.vault.adapter`. Used by the reconnect path: an SSH drop
   * tears down the old `RemoteFsClient`, but the adapter object
   * itself is still wired into Obsidian, so we just rebind it to a
   * fresh client (RPC tunnel or SFTP) without going through a
   * restore/re-patch cycle that would force editors to re-render.
   *
   * Caches are preserved — entries are mtime-keyed, so any divergence
   * is caught on the next read.
   */
  swapClient(newClient: RemoteFsClient): void {
    this.client = newClient;
  }

  /** True between the start of a reconnect loop and its terminal state. */
  private reconnecting = false;

  /**
   * Toggle the "reconnecting" gate. While set:
   *  - read / readBinary serve cached values only and throw on miss
   *  - list / stat / exists throw immediately (no cache fallback)
   *  - any write-side method throws with a clear "reconnecting" notice
   *
   * The reconnect manager flips this on at loop start and off at
   * recovered / failed / cancelled. Existing in-flight calls hit
   * the dead transport and reject naturally — only *new* calls are
   * affected by the gate.
   */
  setReconnecting(on: boolean): void {
    this.reconnecting = on;
  }

  isReconnecting(): boolean {
    return this.reconnecting;
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
   * URL the Obsidian webview should fetch to render this asset. If
   * the ResourceBridge is wired, the URL hits its localhost server
   * (which calls back into this adapter's `readBinary` for the bytes,
   * with all the cache + path-mapping logic intact). Without a bridge
   * we hand back an empty `data:` URL — the asset won't render, but
   * the read path is the only one that actually needs the bridge.
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
    if (this.reconnecting) {
      await this.queueOrThrowText(normalizedPath, data);
      return;
    }
    await this.writeBuffer(normalizedPath, Buffer.from(data, 'utf8'), true);
    // After a successful text write, the file we just wrote IS the
    // new ancestor for any later edit cycle.
    if (this.ancestorTracker) {
      const cached = this.readCache.peek(this.toRemote(normalizedPath));
      this.ancestorTracker.remember(normalizedPath, data, cached?.mtime ?? 0);
    }
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowBinary(normalizedPath, Buffer.from(data));
      return;
    }
    await this.writeBuffer(normalizedPath, Buffer.from(data), false);
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    if (this.reconnecting) {
      // Read locally (cache-only via readBuffer's reconnecting branch),
      // splice, then queue as a full write. Reading + writing as
      // separate ops would explode the queue size when the editor
      // appends in a tight loop.
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
  }

  async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
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
    await this.writeBuffer(normalizedPath, merged, false);
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
  }

  async mkdir(normalizedPath: string): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'mkdir', path: normalizedPath });
      return;
    }
    const remote = this.toRemote(normalizedPath);
    await this.client.mkdirp(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
  }

  async remove(normalizedPath: string): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'remove', path: normalizedPath });
      const remote = this.toRemote(normalizedPath);
      this.readCache.invalidate(remote);
      this.dirCache.invalidate(parentDirRemote(remote));
      this.ancestorTracker?.invalidate(normalizedPath);
      return;
    }
    const remote = this.toRemote(normalizedPath);
    await this.client.remove(remote);
    this.readCache.invalidate(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
    this.ancestorTracker?.invalidate(normalizedPath);
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'rmdir', path: normalizedPath, recursive });
      const remote = this.toRemote(normalizedPath);
      this.readCache.invalidatePrefix(remote);
      this.dirCache.invalidatePrefix(remote);
      this.dirCache.invalidate(parentDirRemote(remote));
      return;
    }
    const remote = this.toRemote(normalizedPath);
    await this.client.rmdir(remote, recursive);
    this.readCache.invalidatePrefix(remote);
    this.dirCache.invalidatePrefix(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
    // AncestorTracker doesn't have prefix invalidation today; in
    // practice rmdir kills folders that the user wasn't editing as
    // text, so the stale entries (if any) just live until LRU pushes
    // them out. Cheap to add later if it ever matters.
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'rename', oldPath, newPath });
      const oldRemote = this.toRemote(oldPath);
      const newRemote = this.toRemote(newPath);
      this.readCache.invalidatePrefix(oldRemote);
      this.readCache.invalidate(newRemote);
      this.dirCache.invalidatePrefix(oldRemote);
      this.dirCache.invalidate(parentDirRemote(oldRemote));
      this.dirCache.invalidate(parentDirRemote(newRemote));
      this.ancestorTracker?.invalidate(oldPath);
      return;
    }
    const oldRemote = this.toRemote(oldPath);
    const newRemote = this.toRemote(newPath);
    await this.client.mkdirp(parentDirRemote(newRemote));
    await this.client.rename(oldRemote, newRemote);
    this.readCache.invalidatePrefix(oldRemote);
    this.readCache.invalidate(newRemote);
    this.dirCache.invalidatePrefix(oldRemote);
    this.dirCache.invalidate(parentDirRemote(oldRemote));
    this.dirCache.invalidate(parentDirRemote(newRemote));
    // Keep the ancestor for `newPath` if one happens to exist (e.g.
    // rename onto an open file) — the user's edit cycle is against
    // whatever they last read at that path, regardless of how the
    // file got there.
    this.ancestorTracker?.invalidate(oldPath);
  }

  async copy(oldPath: string, newPath: string): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'copy', srcPath: oldPath, dstPath: newPath });
      const newRemote = this.toRemote(newPath);
      this.readCache.invalidate(newRemote);
      this.dirCache.invalidate(parentDirRemote(newRemote));
      return;
    }
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
      const msg = (e as Error).message;
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
   * Append a text write to the offline queue and refresh local
   * caches so the editor sees the just-written content. Throws the
   * legacy `reconnecting` error when no queue is wired.
   *
   * The queued op carries `expectedMtime` (the cached mtime at
   * enqueue time — i.e. the mtime the file had when the user started
   * typing) so the replayer can route through the 3-way merge UI on
   * conflict-during-replay.
   *
   * The ancestor tracker is intentionally NOT refreshed here:
   * keeping the original "what user read" snapshot is what makes the
   * eventual conflict modal useful. Refreshing it would erase the
   * pre-edit content and the user would see (mine, mine, theirs) —
   * useless for a real merge decision.
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

    // While reconnecting we can't talk to the remote at all. Serve
    // whatever is already in the cache so already-open editors keep
    // working; throw on a miss rather than block forever.
    if (this.reconnecting) {
      if (cached) {
        this.readCache.get(remote); // bump LRU on hit
        return cached.data;
      }
      throw reconnectingError();
    }

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
   *
   * When the adapter has a recent ReadCache entry for this path, the
   * cached mtime is sent as `expectedMtime` so the server rejects the
   * write if another client wrote in between. On rejection the
   * conflict-resolution stack runs:
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
   * `data` may be reassigned in the merged-decision branch so the
   * post-write cache update reflects what actually landed on disk.
   *
   * `expectedMtimeOverride` lets the offline-queue replayer
   * (E2-β.3) feed in the mtime captured at *enqueue* time rather
   * than whatever the cache holds now (which is the synthetic
   * mtime from the offline cache update).
   */
  private async writeBuffer(
    normalizedPath: string,
    data: Buffer,
    isText: boolean,
    expectedMtimeOverride?: number,
  ): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    const parent = parentDirRemote(remote);
    if (parent && parent !== remote) {
      await this.client.mkdirp(parent);
    }

    const cached = this.readCache.peek(remote);
    const expectedMtime = expectedMtimeOverride ?? cached?.mtime;
    let writtenData = data;
    try {
      await this.client.writeBinary(remote, writtenData, expectedMtime);
    } catch (e) {
      if (expectedMtime === undefined || !isPreconditionFailed(e)) {
        throw e;
      }
      writtenData = await this.resolveWriteConflict(
        normalizedPath, remote, writtenData, isText, e,
      );
    }

    let mtime = 0;
    try {
      const s = await this.client.stat(remote);
      mtime = s.mtime;
    } catch (e) {
      logger.warn(`stat-after-write failed for "${remote}": ${(e as Error).message}`);
    }
    this.readCache.put(remote, writtenData, mtime);
    this.dirCache.invalidate(parent);
  }

  /**
   * Run the conflict-resolution stack (text 3-way → legacy two-choice
   * → rethrow). Returns the data that was actually written, which may
   * differ from the original write when the user chose `merged`. On
   * cancel / keep-theirs / no-callback, throws the original error so
   * the caller's outer try/catch in `writeBuffer` re-surfaces it.
   *
   * On `keep-theirs`, the read cache is refreshed with the remote's
   * current bytes so subsequent reads return the right content even
   * though the editor's in-memory buffer is stale (the editor will
   * reconcile on its next read).
   */
  private async resolveWriteConflict(
    normalizedPath: string,
    remote: string,
    mine: Buffer,
    isText: boolean,
    originalError: unknown,
  ): Promise<Buffer> {
    if (isText && this.ancestorTracker && this.onTextConflict) {
      const ancestor = this.ancestorTracker.get(normalizedPath);
      if (ancestor !== null) {
        let theirsBuf: Buffer;
        try {
          theirsBuf = await this.client.readBinary(remote);
        } catch (re) {
          logger.warn(
            `resolveWriteConflict: re-read of "${remote}" failed (${(re as Error).message}); ` +
            'falling back to the two-choice modal',
          );
          return await this.fallbackTwoChoice(normalizedPath, mine, originalError);
        }
        const decision = await this.onTextConflict(normalizedPath, {
          ancestor: ancestor.content,
          mine:     mine.toString('utf8'),
          theirs:   theirsBuf.toString('utf8'),
        }).catch(() => ({ decision: 'cancel' as const }));

        switch (decision.decision) {
          case 'keep-mine':
            await this.client.writeBinary(remote, mine);
            return mine;
          case 'merged': {
            const merged = Buffer.from(decision.content, 'utf8');
            await this.client.writeBinary(remote, merged);
            return merged;
          }
          case 'keep-theirs': {
            // Refresh the cache so the editor's next read picks up
            // theirs without another round-trip; the user-visible
            // outcome is "the write was discarded, we're now showing
            // the remote".
            let mtime = 0;
            try {
              const s = await this.client.stat(remote);
              mtime = s.mtime;
            } catch { /* best effort */ }
            this.readCache.put(remote, theirsBuf, mtime);
            // Refresh ancestor too so the user's NEXT edit cycle is
            // measured against what they're now looking at.
            if (this.ancestorTracker) {
              this.ancestorTracker.remember(normalizedPath, theirsBuf.toString('utf8'), mtime);
            }
            throw originalError;
          }
          case 'cancel':
            throw originalError;
        }
      }
    }
    return await this.fallbackTwoChoice(normalizedPath, mine, originalError);
  }

  /**
   * Two-choice (overwrite / cancel) conflict path — the binary
   * fallback and the no-ancestor fallback for text. Throws on
   * cancel; returns `mine` on overwrite (so the caller's cache
   * update reflects what landed).
   */
  private async fallbackTwoChoice(
    normalizedPath: string,
    mine: Buffer,
    originalError: unknown,
  ): Promise<Buffer> {
    if (!this.onWriteConflict) throw originalError;
    const overwrite = await this.onWriteConflict(normalizedPath).catch(() => false);
    if (!overwrite) throw originalError;
    await this.client.writeBinary(this.toRemote(normalizedPath), mine);
    return mine;
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

/**
 * Stable error thrown by every adapter method while a reconnect is
 * in flight. Distinguishes the "remote is temporarily unavailable"
 * case from "file not found" / "permission denied" so callers (and
 * the Obsidian editor in particular) can surface a friendly notice
 * rather than a generic IO failure.
 */
function reconnectingError(): Error {
  return new Error('Remote SSH: reconnecting — try again once the connection is restored');
}

/**
 * Recognise the `PreconditionFailed` (-32020) error the daemon
 * returns when an `fs.write` with `expectedMtime` finds the remote
 * mtime has moved. Duck-typed against the `code` property so we
 * don't have to import `RpcError` from the transport layer (the
 * SFTP path also passes through this adapter and wraps its own
 * errors differently).
 */
function isPreconditionFailed(e: unknown): boolean {
  return typeof e === 'object'
      && e !== null
      && 'code' in e
      && (e as { code: unknown }).code === -32020;
}
