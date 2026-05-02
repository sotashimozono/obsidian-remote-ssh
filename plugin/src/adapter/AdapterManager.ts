import type { App, PluginManifest } from 'obsidian';
import { FileSystemAdapter, Notice } from 'obsidian';
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
import { OfflineQueue } from '../offline/OfflineQueue';
import { QueueReplayer } from '../offline/QueueReplayer';
import { PendingEditsBar } from '../ui/PendingEditsBar';
import { PendingEditsModal } from '../ui/PendingEditsModal';
import type { ConnectionManager } from '../ConnectionManager';
import { ConnectionManager as CM } from '../ConnectionManager';
import type { FsChangeListener } from '../vault/FsChangeListener';
import { PathMapper } from '../path/PathMapper';
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
  // basePath surface — patched so plugins that join paths against
  // it (Templater's tp.file.path, Kanban clipboard paste, Importer,
  // Copilot — see docs/plugin-compatibility.md "basePath compat
  // survey") get the shadow-vault local root explicitly. The natural
  // FileSystemAdapter getter already returns this value, but routing
  // through the replacement makes the contract explicit and gives
  // tests a single hook to assert on. #170, follow-up to #133.
  'basePath', 'getBasePath',
] as const;

/**
 * Manages the lifetime of the monkey-patched `app.vault.adapter`,
 * the ResourceBridge, and the OfflineQueue. Extracted from main.ts
 * so that adapter-lifecycle concerns are cohesive and independently
 * testable (issue #197).
 *
 * Call {@link patch} after a successful SSH connect; call
 * {@link restore} on disconnect or plugin unload.
 */
export class AdapterManager {
  private patcher: AdapterPatcher<Record<string, unknown>> | null = null;
  private _dataAdapter: SftpDataAdapter | null = null;
  private readCache: ReadCache | null = null;
  private dirCache: DirCache | null = null;
  private ancestorTracker: AncestorTracker | null = null;
  private offlineQueue: OfflineQueue | null = null;
  private resourceBridge: ResourceBridge | null = null;

  constructor(
    private readonly app: App,
    private readonly manifest: PluginManifest,
    private readonly conn: ConnectionManager,
    private readonly fsChangeListener: FsChangeListener,
    private readonly pendingEditsBar: PendingEditsBar,
    private readonly getSettings: () => PluginSettings,
  ) {}

  get dataAdapter(): SftpDataAdapter | null {
    return this._dataAdapter;
  }

  isPatched(): boolean {
    return this.patcher?.isPatched() ?? false;
  }

  /**
   * Build the SftpDataAdapter, start the ResourceBridge, monkey-patch
   * `app.vault.adapter`, and subscribe to fs.watch when the active
   * transport is RPC.
   *
   * Returns true on success, false on failure. Silent — the caller
   * decides what notice (if any) to surface.
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
    // Capture the shadow vault's local root *before* patching. The
    // running window is the shadow window, so its FileSystemAdapter
    // already points at `~/.obsidian-remote/vaults/<P-id>/`; we feed
    // that value back into SftpDataAdapter so the patched basePath /
    // getBasePath surface returns it explicitly. Falls back to '' if
    // the host adapter isn't a FileSystemAdapter (mobile / unusual
    // builds) — plugins that read basePath in those environments
    // already had no useful answer. #170.
    const shadowBasePath = this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getBasePath()
      : '';
    this.readCache = new ReadCache();
    this.dirCache = new DirCache();
    // Pick the transport that matches the active session: when an
    // RPC tunnel is up, route everything through the daemon; otherwise
    // fall back to the direct-SFTP wrapper. The adapter itself is
    // unaware of the choice — both clients implement RemoteFsClient.
    const fsClient = this.conn.buildFsClient();
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

    // Spin up the localhost binary bridge so getResourcePath has
    // somewhere to send Obsidian. The bridge is best-effort: if it
    // fails to bind we still patch and just lose image rendering.
    //
    // When the active session is RPC AND the daemon advertises
    // `fs.thumbnail`, also wire the thumbnail fetcher — image-extension
    // requests get served from the daemon's resize path (small, cached)
    // instead of pulling the full original on every <img>.
    const bridge = new ResourceBridge();
    const fetchThumbnail = this.makeThumbnailFetcherIfSupported();
    const fetchBinaryRange = this.makeBinaryRangeFetcherIfSupported();
    try {
      await bridge.start(
        p => this.fetchBinaryForBridge(p),
        fetchThumbnail ?? undefined,
        fetchBinaryRange ?? undefined,
      );
      this.resourceBridge = bridge;
      if (fetchThumbnail) {
        logger.info('ResourceBridge: thumbnail fast path enabled (daemon supports fs.thumbnail)');
      }
      if (fetchBinaryRange) {
        logger.info('ResourceBridge: range fast path enabled (daemon supports fs.readBinaryRange)');
      }
    } catch (e) {
      logger.warn(`ResourceBridge: start failed: ${errorMessage(e)}`);
      this.resourceBridge = null;
    }

    // The Go daemon already knows the absolute vault root via its
    // `--vault-root` flag, so RPC clients must send paths RELATIVE to
    // that root (empty string for the root itself). Sending the same
    // `work/VaultDev` prefix the SFTP path needs would double up:
    // daemon-side `Resolve(absRoot, "work/VaultDev")` becomes
    // `<absRoot>/work/VaultDev`, missing the real vault entirely
    // (or — when a stale doubled mirror exists — quietly listing it).
    // The SFTP transport has no such root-knowing server; it does need
    // the prefix to anchor calls at the vault.
    const adapterRemoteBase = this.conn.rpcConnection ? '' : this.conn.activeRemoteBasePath;
    // Per-session ancestor snapshot store. Powers the 3-way merge UI;
    // cleared on disconnect with the rest of the patched-adapter state.
    this.ancestorTracker = new AncestorTracker();
    // Persistent offline-write queue. Survives Electron restarts and
    // adapter restores so an in-flight disconnect doesn't drop user
    // edits. Lazily-opened the first time the adapter is patched;
    // reused on subsequent patches so the queue isn't re-replayed.
    if (!this.offlineQueue) {
      try {
        this.offlineQueue = await this.openOfflineQueue();
        const stats = this.offlineQueue.stats();
        if (stats.entries > 0) {
          logger.info(
            `OfflineQueue: opened with ${stats.entries} pending entries (${stats.bytes} bytes) ` +
            'from a previous session — the QueueReplayer will drain them on connect',
          );
        }
        // Wire the status-bar indicator to this queue. Polls every
        // 2 s; cheap (Map.size) and the user expects an at-a-glance
        // count rather than per-event live updates.
        const queue = this.offlineQueue;
        this.pendingEditsBar.startPolling(() => queue.pending().length);
      } catch (e) {
        logger.warn(`OfflineQueue: open failed (${errorMessage(e)}); offline writes will throw`);
        this.offlineQueue = null;
      }
    }
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
    );
    this.patcher = new AdapterPatcher(targetAdapter, this._dataAdapter);
    try {
      this.patcher.patch(PATCHED_METHODS);
      logger.info(`Adapter patched via ${transportLabel}: [${PATCHED_METHODS.join(', ')}]`);
    } catch (e) {
      logger.error(`Adapter patch failed: ${errorMessage(e)}`);
      this.patcher = null;
      this._dataAdapter = null;
      this.readCache = null;
      this.dirCache = null;
      // Patch failed before we ever served a URL, so no point keeping
      // the bridge alive for nobody.
      void this.stopResourceBridge();
      return false;
    }

    // Live-update subscription is only meaningful on the RPC transport;
    // the SFTP fallback has no notification channel.
    if (this.conn.rpcConnection) {
      void this.fsChangeListener.subscribe({
        rpcConnection: this.conn.rpcConnection,
        dataAdapter: this._dataAdapter,
        pathMapper: mapper,
      });
    }

    return true;
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
    this._dataAdapter = null;
    this.readCache = null;
    this.dirCache = null;
    this.ancestorTracker?.clear();
    this.ancestorTracker = null;
    // Bridge tears down asynchronously; we don't await here because
    // restore() must remain sync for the connection-close hook.
    void this.stopResourceBridge();
    // The legacy reconcileVaultRoot walk used to fire here to put
    // File Explorer back to the local view after un-patching, but
    // shadow vaults are torn down by closing their window — there's
    // no in-place "switch back" UX to support anymore.
  }

  /**
   * Drive the offline write queue against the live adapter. Called
   * on every connect (initial and post-reconnect). Idempotent: if
   * the queue is empty the run is a no-op; if entries error mid-
   * drain the rest stay queued for the next reconnect.
   */
  async replayOfflineQueue(label: 'after-connect' | 'after-reconnect'): Promise<void> {
    if (!this.offlineQueue || !this._dataAdapter) return;
    const pendingBefore = this.offlineQueue.pending().length;
    if (pendingBefore === 0) return;
    logger.info(`replayOfflineQueue(${label}): ${pendingBefore} pending entries`);
    try {
      const replayer = new QueueReplayer(this.offlineQueue, this._dataAdapter);
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
   * Open the persistent offline-write queue under
   * `<vault>/.obsidian/plugins/<id>/queue/`. The dir lives next to
   * the plugin's other on-disk state (data.json, console.log, the
   * thumbnails cache the daemon writes elsewhere) so a vault move
   * carries the pending writes with it.
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await conn.rpc.call('fs.thumbnail', { path: vaultPath, maxDim }) as any;
      const buf = Buffer.from(result.contentBase64, 'base64');
      return {
        bytes:  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        format: result.format,
      };
    };
  }

  /**
   * Build the bridge's range fetcher when the active session can
   * support it (#134). Returns `null` for SFTP transports or for
   * daemons that don't advertise `fs.readBinaryRange` — the bridge
   * then transparently falls back to the full-binary path on every
   * `Range:` request, which still works but allocates the whole file
   * into memory just to slice.
   */
  private makeBinaryRangeFetcherIfSupported(): null | ((vaultPath: string, offset: number, length: number, expectedMtime?: number) => Promise<{ bytes: Uint8Array; mtime: number; totalSize: number }>) {
    const conn = this.conn.rpcConnection;
    if (!conn) return null;
    if (!conn.info.capabilities.includes('fs.readBinaryRange')) return null;
    return async (vaultPath, offset, length, expectedMtime) => {
      // Daemon's ReadBinaryRangeParams treats `expectedMtime` as
      // optional — only include it when the bridge actually has a
      // cached generation to pin against. The daemon rejects with
      // PreconditionFailed (-32020) when the remote mtime no longer
      // matches; ResourceBridge catches that and re-issues with
      // `expectedMtime: undefined`. #171.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await conn.rpc.call('fs.readBinaryRange', {
        path: vaultPath,
        offset,
        length,
        ...(expectedMtime !== undefined ? { expectedMtime } : {}),
      }) as any;
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
