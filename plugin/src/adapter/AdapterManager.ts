import type { App, PluginManifest } from 'obsidian';
import { FileSystemAdapter, Notice, TFile, TFolder } from 'obsidian';
import { VaultModelBuilder } from '../vault/VaultModelBuilder';
import { LocalOpRegistry } from './LocalOpRegistry';
import type { PluginSettings } from '../types';
import { ReadCache } from '../cache/ReadCache';
import { DirCache } from '../cache/DirCache';
import { SftpDataAdapter } from './SftpDataAdapter';
import { AdapterPatcher } from './AdapterPatcher';
import { ResourceBridge } from './ResourceBridge';
import { WriteConflictModal } from '../ui/WriteConflictModal';
import { ThreeWayMergeModal } from '../ui/ThreeWayMergeModal';
import { AncestorTracker } from '../conflict/AncestorTracker';
import { ConflictResolver } from '../conflict/ConflictResolver';
import { OfflineQueue, type QueuedOp } from '../offline/OfflineQueue';
import { QueueReplayer } from '../offline/QueueReplayer';
import { PendingEditsBar } from '../ui/PendingEditsBar';
import { PendingEditsModal } from '../ui/PendingEditsModal';
import type { ConnectionManager } from '../ConnectionManager';
import { ConnectionManager as CM } from '../ConnectionManager';
import type { FsChangeListener } from '../vault/FsChangeListener';
import type { TransferTracker } from '../util/TransferTracker';
import { PathMapper } from '../path/PathMapper';
import type { StartupReadGate } from './StartupReadGate';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';
import * as path from 'path';

/**
 * The set of FileSystemAdapter methods that get monkey-patched onto
 * `app.vault.adapter` when the plugin is connected. Kept here so
 * the list and the patching logic live in the same file.
 */
export const PATCHED_METHODS = [
  // read-side
  'getName', 'exists', 'stat', 'list', 'read', 'readBinary',
  // write-side
  'write', 'writeBinary', 'append', 'appendBinary', 'process',
  // fs ops
  'mkdir', 'remove', 'rmdir', 'rename', 'copy',
  // trash
  'trashSystem', 'trashLocal',
  // resources (binary URL for <img> / <iframe> / <audio>)
  'getResourcePath',
  // Patched so plugins joining paths against it get the shadow root
  // explicitly. The native getter returns the same value; routing through the
  // replacement makes the contract explicit and gives tests one hook. #170.
  'basePath', 'getBasePath',
] as const;

/**
 * Owns the lifetime of the patched `app.vault.adapter`, the ResourceBridge
 * and the OfflineQueue. {@link patch} after a connect, {@link restore} on
 * disconnect or unload.
 *
 * Lifted out of `main.ts` (#197) so those three lifetimes sit together and
 * can be tested without standing up a plugin — worth knowing before anyone
 * folds it back in.
 */
export class AdapterManager {
  private patcher: AdapterPatcher<Record<string, unknown>> | null = null;
  private _dataAdapter: SftpDataAdapter | null = null;
  private readCache: ReadCache | null = null;
  private dirCache: DirCache | null = null;
  private ancestorTracker: AncestorTracker | null = null;
  private offlineQueue: OfflineQueue | null = null;
  /** Holds startup note calls until the patch; see `StartupReadGate`. */
  private startupGate: StartupReadGate | null = null;
  /** The replay in flight, if any; see `replayOfflineQueue`. */
  private replaying: Promise<void> | null = null;
  /** Bumped by `restore()`, so replays queued in a torn-down session stand down. */
  private replayGeneration = 0;
  private resourceBridge: ResourceBridge | null = null;

  constructor(
    private readonly app: App,
    private readonly manifest: PluginManifest,
    private readonly conn: ConnectionManager,
    private readonly fsChangeListener: FsChangeListener,
    private readonly pendingEditsBar: PendingEditsBar,
    private readonly getSettings: () => PluginSettings,
    private readonly transferTracker: TransferTracker | null = null,
  ) {}

  /** The startup read gate; `patch()` hands its held calls to the remote adapter. */
  setStartupGate(gate: StartupReadGate | null): void {
    this.startupGate = gate;
  }

  get dataAdapter(): SftpDataAdapter | null {
    return this._dataAdapter;
  }

  isPatched(): boolean {
    return this.patcher?.isPatched() ?? false;
  }

  /**
   * Build the adapter, start the bridge, patch `app.vault.adapter`, and
   * subscribe to fs.watch on RPC. Silent on failure — the caller decides what
   * to show.
   */
  async patch(): Promise<boolean> {
    if (!this.conn.activeRemoteBasePath) {
      logger.warn('AdapterManager.patch: no active remote base path');
      return false;
    }
    if (this.patcher?.isPatched()) {
      logger.info('AdapterManager.patch: adapter already patched');
      return true;
    }
    const targetAdapter = this.app.vault.adapter as unknown as Record<string, unknown>;
    // Before patching: the host adapter still points at the shadow root, and
    // that value is what the patched `basePath` must return. `''` on a host
    // that is not a FileSystemAdapter — there was never a useful answer
    // there anyway. #170.
    const shadowBasePath = this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getBasePath()
      : '';
    this.readCache = new ReadCache();
    this.dirCache = new DirCache();
    // One value carries both halves — which client, and what prefix its paths
    // need — because a reconnect can change them together. See
    // `ConnectionManager.buildBinding`.
    const binding = this.conn.buildBinding();
    const fsClient = binding.client;
    const transportLabel = this.conn.rpcConnection ? 'RPC' : 'SFTP';
    // Per-client path remapping: client-private files like
    // .obsidian/workspace.json get redirected into a per-client subtree
    // on the remote so two machines on the same vault don't trample
    // each other's UI state. Phase 4-J0.
    const clientId = CM.resolveClientId(this.getSettings());
    // Pass `app.vault.configDir` so PathMapper builds its private-subtree
    // routing against the user's actual config directory (defaults to
    // `.obsidian` but is configurable in Obsidian's appearance settings).
    const mapper = new PathMapper(clientId, this.app.vault.configDir);
    logger.info(`PathMapper: clientId="${clientId}"`);

    this.resourceBridge = await this.startResourceBridge();

    // The daemon knows the vault root from its `--vault-root` flag, so RPC
    // paths must be relative to it. Sending the SFTP prefix as well makes
    // `Resolve(absRoot, "work/VaultDev")` land at `<absRoot>/work/VaultDev` —
    // missing the vault, or quietly listing a stale doubled mirror. SFTP has
    // no such server and does need the prefix.
    const adapterRemoteBase = binding.remoteBase;
    // Per-session ancestor snapshot store. Powers the 3-way merge UI;
    // cleared on disconnect with the rest of the patched-adapter state.
    this.ancestorTracker = new AncestorTracker();
    await this.ensureOfflineQueue();
    const conflictResolver = new ConflictResolver(
      fsClient,
      this.readCache,
      this.ancestorTracker,
      (vaultPath, panes) => new ThreeWayMergeModal(this.app, { path: vaultPath, ...panes }).prompt(),
      (vaultPath) => new WriteConflictModal(this.app, vaultPath).prompt(),
    );
    this._dataAdapter = new SftpDataAdapter(
      fsClient,
      adapterRemoteBase,
      this.readCache,
      this.dirCache,
      this.app.vault.getName(),
      mapper,
      this.resourceBridge,
      conflictResolver,
      this.ancestorTracker,
      this.offlineQueue,
      shadowBasePath,
      this.transferTracker,
    );
    // Synchronously before the patch, so the patcher captures (and restore()
    // later puts back) the native members, not the gate's wrappers.
    this.startupGate?.uninstall();
    this.patcher = new AdapterPatcher(targetAdapter, this._dataAdapter);
    try {
      this.patcher.patch(PATCHED_METHODS);
      logger.info(`Adapter patched via ${transportLabel}: [${PATCHED_METHODS.join(', ')}]`);
    } catch (e) {
      logger.error(`Adapter patch failed: ${errorMessage(e)}`);
      this.openStartupGate();
      this.patcher = null;
      this._dataAdapter = null;
      this.readCache = null;
      this.dirCache = null;
      // Patch failed before we ever served a URL, so no point keeping
      // the bridge alive for nobody.
      void this.stopResourceBridge();
      return false;
    }

    this.wireLiveUpdates(this._dataAdapter, mapper);
    // Held calls re-dispatch through the members just patched in.
    this.openStartupGate();

    return true;
  }

  /** Release held startup calls (to the remote adapter, if patched). Idempotent. */
  openStartupGate(): void {
    this.startupGate?.open();
    this.startupGate = null;
  }

  /**
   * Start the localhost bridge `getResourcePath` sends Obsidian to.
   *
   * Best-effort: one that cannot bind costs image rendering, not the session.
   * A daemon advertising the thumbnail or range methods also gets those fast
   * paths wired.
   *
   * `bridge` is a test seam, like `JumpHostTunnel`'s `clientFactory` — the
   * bind failure is the branch worth pinning and a real bridge will not
   * produce it on request.
   */
  private async startResourceBridge(
    bridge: ResourceBridge = new ResourceBridge(),
  ): Promise<ResourceBridge | null> {
    const fetchThumbnail = this.makeThumbnailFetcherIfSupported();
    const fetchBinaryRange = this.makeBinaryRangeFetcherIfSupported();
    try {
      await bridge.start(
        p => this.fetchBinaryForBridge(p),
        fetchThumbnail ?? undefined,
        fetchBinaryRange ?? undefined,
      );
      if (fetchThumbnail) {
        logger.info('ResourceBridge: thumbnail fast path enabled (daemon supports fs.thumbnail)');
      }
      if (fetchBinaryRange) {
        logger.info('ResourceBridge: range fast path enabled (daemon supports fs.readBinaryRange)');
      }
      return bridge;
    } catch (e) {
      logger.warn(`ResourceBridge: start failed: ${errorMessage(e)}`);
      return null;
    }
  }

  /**
   * Open the persistent offline-write queue, once.
   *
   * It survives Electron restarts and adapter restores so an in-flight
   * disconnect does not drop user edits, and it is reused across patches so
   * the queue is not replayed twice. A queue that will not open leaves
   * offline writes throwing, which is louder than losing them.
   */
  private async ensureOfflineQueue(): Promise<void> {
    if (this.offlineQueue) return;
    try {
      this.offlineQueue = await this.openOfflineQueue();
      const stats = this.offlineQueue.stats();
      if (stats.entries > 0) {
        logger.info(
          `OfflineQueue: opened with ${stats.entries} pending entries (${stats.bytes} bytes) ` +
          'from a previous session — the QueueReplayer will drain them on connect',
        );
      }
      // Polls every 2 s: cheap (Map.size), and an at-a-glance count is what
      // the user wants from a status bar, not per-event updates.
      const queue = this.offlineQueue;
      this.pendingEditsBar.startPolling(() => queue.pending().length);
    } catch (e) {
      logger.warn(`OfflineQueue: open failed (${errorMessage(e)}); offline writes will throw`);
      this.offlineQueue = null;
    }
  }

  /**
   * Wire the two paths that keep the vault model current.
   *
   * Self-reflect (#341) is transport-independent and wired once: the builder
   * is stateless and the adapter outlives a reconnect's `rebind`.
   *
   * The subscription only means anything on RPC. There the daemon echoes our
   * own writes back, and the SHARED registry is what lets `FsChangeListener`
   * drop that echo instead of firing a second time. Other clients' changes
   * never pass through `record`, so their echoes still apply.
   */
  private wireLiveUpdates(adapter: SftpDataAdapter, mapper: PathMapper): void {
    const localOpRegistry = new LocalOpRegistry();
    adapter.setWriterReflector(new VaultModelBuilder(this.app.vault, { TFile, TFolder }));
    adapter.setLocalOpRegistry(localOpRegistry);

    if (this.conn.rpcConnection) {
      void this.fsChangeListener.subscribe({
        rpcConnection: this.conn.rpcConnection,
        dataAdapter: adapter,
        pathMapper: mapper,
        localOpRegistry,
      });
    }
  }

  /**
   * Drop the watch subscription, restore the original adapter, and
   * tear down the ResourceBridge. Idempotent.
   */
  restore(): void {
    // Drop the watch subscription before tearing the adapter down so
    // any in-flight fs.changed callbacks find a still-valid adapter
    // (or, if the handler races, a null `dataAdapter` which it tolerates).
    this.fsChangeListener.unsubscribe(this.conn.rpcConnection);
    const wasPatched = this.patcher?.isPatched() ?? false;
    if (wasPatched) {
      try {
        this.patcher!.restore();
        logger.info('Adapter restored');
      } catch (e) {
        logger.error(`Adapter restore failed: ${errorMessage(e)}`);
      }
    }
    this.patcher = null;
    // Retire the adapter before dropping the reference. Reads parked in
    // ReconnectWait poll the ADAPTER's own flags; once `_dataAdapter` is null
    // nothing can reach it (main.ts resets state via
    // `dataAdapter?.setReconnecting(false)`), so they would sit out the full
    // 30 s budget. `dispose()` rather than `setReconnecting(false)`: clearing
    // the reconnect flag would also tell the read path the session is healthy,
    // and it would then hit the wire on a transport this teardown is
    // abandoning — the reconnect-failed path does not close it.
    this._dataAdapter?.dispose();
    this._dataAdapter = null;
    // End this session's replays: the one running stops after its current op
    // (it may sit on a modal), and those queued behind it never start. The
    // next session's replay still waits its turn, so nothing runs twice.
    this.replayGeneration++;
    this.readCache = null;
    this.dirCache = null;
    this.ancestorTracker?.clear();
    this.ancestorTracker = null;
    this.transferTracker?.clear();
    // Bridge tears down asynchronously; we don't await here because
    // restore() must remain sync for the connection-close hook.
    void this.stopResourceBridge();
    // The legacy reconcileVaultRoot walk used to fire here to put
    // File Explorer back to the local view after un-patching, but
    // shadow vaults are torn down by closing their window — there's
    // no in-place "switch back" UX to support anymore.
  }

  /**
   * Where the model and the remote legitimately disagree until the offline
   * queue replays, for a walk to leave alone. Null when nothing is queued.
   *
   * `keep`: what queued ops add (writes, mkdirs, copy and rename targets),
   * everything under it and the folders above it. The model is ahead there:
   * never remove it or downgrade its stat, but add it if the model lacks it
   * (a write queued in an earlier launch never reached this model).
   *
   * `skip`: what queued ops remove (remove, rmdir, trash, rename sources) and
   * everything under it. The remote is ahead: never add it back.
   */
  pendingOfflineFilter(): { skip: (path: string) => boolean; keep: (path: string) => boolean } | null {
    const added = new Set<string>();
    const removed = new Set<string>();
    for (const { op } of this.offlineQueue?.pending() ?? []) {
      const { adds, removes } = opEffects(op);
      for (const p of adds) added.add(p);
      for (const p of removes) removed.add(p);
    }
    if (added.size + removed.size === 0) return null;
    const above = new Set<string>();
    for (const q of added) for (const a of ancestors(q)) above.add(a);
    // Sets, not a scan per path: this runs over every walked entry, and an
    // hour of offline autosaves queues hundreds of ops.
    return {
      skip: (p) => atOrUnder(p, removed),
      keep: (p) => above.has(p) || atOrUnder(p, added),
    };
  }

  /**
   * Drive the offline write queue against the live adapter. Called
   * on every connect (initial and post-reconnect). Idempotent: if
   * the queue is empty the run is a no-op; if entries error mid-
   * drain the rest stay queued for the next reconnect. A call while
   * a replay runs (one can wait on a conflict modal across a drop)
   * waits for it, then drains what is queued by then: nothing runs
   * twice at once, and edits queued meanwhile are not left behind.
   * A replay outlives neither its session nor `restore()`.
   */
  replayOfflineQueue(label: 'after-connect' | 'after-reconnect'): Promise<void> {
    const generation = this.replayGeneration;
    const run = (this.replaying ?? Promise.resolve()).then(() =>
      generation === this.replayGeneration ? this.drainOfflineQueue(label) : undefined);
    this.replaying = run;
    void run.finally(() => { if (this.replaying === run) this.replaying = null; });
    return run;
  }

  private async drainOfflineQueue(label: 'after-connect' | 'after-reconnect'): Promise<void> {
    if (!this.offlineQueue || !this._dataAdapter) return;
    const pendingBefore = this.offlineQueue.pending().length;
    if (pendingBefore === 0) return;
    logger.info(`replayOfflineQueue(${label}): ${pendingBefore} pending entries`);
    try {
      // Bound to this session: once `restore()` ends it, the next op errors,
      // which stops the drain and leaves the rest for the next session's.
      const generation = this.replayGeneration;
      const adapter = this._dataAdapter;
      const replayer = new QueueReplayer(this.offlineQueue, {
        replayQueuedOp: (op) => generation === this.replayGeneration
          ? adapter.replayQueuedOp(op)
          : Promise.resolve({ result: 'error', message: 'the session that started this replay ended' }),
      });
      const report = await replayer.run();
      const stillPending = this.offlineQueue.pending().length;
      const summary =
        `replayOfflineQueue(${label}) done: drained=${report.drained}, ` +
        `conflicts=${report.conflicts}, errors=${report.errors.length}, ` +
        `remaining=${stillPending}`;
      logger.info(summary);
      if (report.drained > 0) {
        new Notice(
          `Remote SSH: replayed ${report.drained} offline edit` +
          `${report.drained === 1 ? '' : 's'}` +
          (stillPending > 0 ? ` (${stillPending} pending)` : ''),
        );
      }
      if (report.errors.length > 0) {
        new Notice(
          `Remote SSH: ${report.errors.length} offline edit` +
          `${report.errors.length === 1 ? '' : 's'} failed to replay; will retry on next connect`,
        );
      }
    } catch (e) {
      logger.warn(`replayOfflineQueue(${label}) crashed: ${errorMessage(e)}`);
    }
  }

  /**
   * Show the pending-edits listing modal. Discarding clears the
   * queue (destructive — there's no undo). The listing is a snapshot
   * taken at modal-open time; if the queue mutates while the modal
   * is open the user just sees the next snapshot on their next click.
   */
  async showPendingEditsModal(): Promise<void> {
    if (!this.offlineQueue) return;
    const entries = this.offlineQueue.pending();
    if (entries.length === 0) return;
    const decision = await new PendingEditsModal(this.app, entries).prompt();
    if (decision.decision === 'discard-all') {
      const dropped = entries.length;
      try {
        await this.offlineQueue.clear();
        new Notice(`Remote SSH: discarded ${dropped} pending edit${dropped === 1 ? '' : 's'}`);
      } catch (e) {
        logger.warn(`PendingEditsModal: queue.clear() failed: ${errorMessage(e)}`);
        new Notice('Remote SSH: failed to clear the offline queue (see console.log)');
      }
    }
  }

  /**
   * Under the plugin's own dir, beside data.json and the log, so moving the
   * vault carries the pending writes with it.
   */
  private async openOfflineQueue(): Promise<OfflineQueue> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('vault is not FileSystemAdapter-backed');
    }
    const dir = path.join(
      adapter.getBasePath(),
      this.app.vault.configDir,
      'plugins',
      this.manifest.id,
      'queue',
    );
    return await OfflineQueue.open(dir);
  }

  /**
   * Bridge → adapter glue: fetch a binary asset through the patched
   * adapter so the bridge benefits from caching and PathMapper
   * translation. Returns `Uint8Array` as the bridge expects.
   */
  private async fetchBinaryForBridge(vaultPath: string): Promise<Uint8Array> {
    if (!this._dataAdapter) {
      throw new Error('adapter is not patched');
    }
    return this._dataAdapter.fetchBinaryForBridge(vaultPath);
  }

  /**
   * Build the bridge's thumbnail fetcher when the active session can
   * support it. Returns `null` for SFTP transports or for daemons
   * that don't advertise `fs.thumbnail` — the bridge then transparently
   * falls back to the full-binary path on `<img>` requests.
   */
  private makeThumbnailFetcherIfSupported(): null | ((vaultPath: string, maxDim: number) => Promise<{ bytes: Uint8Array; format: 'jpeg' | 'png' }>) {
    const conn = this.conn.rpcConnection;
    if (!conn) return null;
    if (!conn.info.capabilities.includes('fs.thumbnail')) return null;
    return async (vaultPath, maxDim) => {
      // Read the connection at call time, not at wiring time. `patch()` runs
      // once per connect; a reconnect replaces `rpcConnection` without
      // re-running it, so a captured handle is dead from the first reconnect
      // onwards. The bridge catches the failure and falls back to fetching
      // the whole file, so this degrades silently and permanently rather
      // than breaking — which is why it went unnoticed.
      const live = this.conn.rpcConnection ?? conn;
      const result = await live.rpc.call('fs.thumbnail', { path: vaultPath, maxDim });
      const buf = Buffer.from(result.contentBase64, 'base64');
      return {
        bytes:  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        format: result.format,
      };
    };
  }

  /**
   * The bridge's range fetcher, or `null` when the session cannot serve one
   * (#134). The bridge then falls back to the full binary on every `Range:`
   * — correct, but it allocates the whole file just to slice it.
   */
  private makeBinaryRangeFetcherIfSupported(): null | ((vaultPath: string, offset: number, length: number, expectedMtime?: number) => Promise<{ bytes: Uint8Array; mtime: number; totalSize: number }>) {
    const conn = this.conn.rpcConnection;
    if (!conn) return null;
    if (!conn.info.capabilities.includes('fs.readBinaryRange')) return null;
    return async (vaultPath, offset, length, expectedMtime) => {
      // Only sent when the bridge has a generation to pin against; the daemon
      // then rejects a newer one and the bridge re-issues unpinned (#171).
      // Read live, not captured — see the thumbnail fetcher above.
      const live = this.conn.rpcConnection ?? conn;
      const result = await live.rpc.call('fs.readBinaryRange', {
        path: vaultPath,
        offset,
        length,
        ...(expectedMtime !== undefined ? { expectedMtime } : {}),
      });
      const buf = Buffer.from(result.contentBase64, 'base64');
      return {
        bytes:     new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        mtime:     result.mtime,
        totalSize: result.size,
      };
    };
  }

  /** Stop the resource bridge if running. Idempotent. */
  private async stopResourceBridge(): Promise<void> {
    const bridge = this.resourceBridge;
    if (!bridge) return;
    this.resourceBridge = null;
    try {
      await bridge.stop();
    } catch (e) {
      logger.warn(`ResourceBridge: stop failed: ${errorMessage(e)}`);
    }
  }
}

function opEffects(op: QueuedOp): { adds: string[]; removes: string[] } {
  switch (op.kind) {
    case 'rename':     return { adds: [op.newPath], removes: [op.oldPath] };
    case 'copy':       return { adds: [op.dstPath], removes: [] };
    case 'remove':
    case 'rmdir':
    case 'trashLocal': return { adds: [], removes: [op.path] };
    default:           return { adds: [op.path], removes: [] };
  }
}

function atOrUnder(path: string, set: ReadonlySet<string>): boolean {
  if (set.has(path)) return true;
  for (const a of ancestors(path)) if (set.has(a)) return true;
  return false;
}

/** `a/b/c` → `a/b`, `a`. */
function* ancestors(path: string): Generator<string> {
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) yield path.slice(0, i);
}
