import { App, TFile, TFolder } from 'obsidian';
import type { SftpDataAdapter } from '../adapter/SftpDataAdapter';
import type { PathMapper } from '../path/PathMapper';
import type { RpcConnection } from '../transport/RpcConnection';
import type { FsChangedParams } from '../proto/types';
import { interpretWatchEvent } from '../path/WatchEventFilter';
import { VaultModelBuilder } from './VaultModelBuilder';
import { logger } from '../util/logger';
import { perfTracer } from '../util/PerfTracer';

/**
 * Owns the daemon-side `fs.watch` subscription and its notification
 * pipeline: receive `fs.changed` push frames, invalidate the relevant
 * cache entries on the SftpDataAdapter, then mutate the vault model
 * via `VaultModelBuilder` so File Explorer / Quick Switcher /
 * MetadataCache pick up creates / deletes / renames the same way
 * Obsidian's local-FS watcher would.
 *
 * Extracted from main.ts (Phase Refactor / God-file split, PR 3/3).
 * The listener owns three pieces of state that used to live as
 * private fields on the plugin (rpcWatchSubscriptionId,
 * rpcWatchHandlerDisposer, activePathMapper) — collapsing them here
 * removes one entire concern from the plugin's surface.
 *
 * Lifecycle:
 *
 *   subscribe(...)        — patchAdapter runs subscribe once when the
 *                           transport is RPC. Idempotent.
 *   prepareForReconnect() — reconnectAttempt drops local state before
 *                           re-establishing the SSH session (the
 *                           daemon-side subscription is already dead).
 *   resumeAfterReconnect  — reconnectAttempt rebinds against the fresh
 *                           rpc / adapter using the previously-captured
 *                           pathMapper. No-op if subscribe() never ran.
 *   unsubscribe(rpc)      — restoreAdapter sends fs.unwatch and clears
 *                           all state. Safe to call when nothing was
 *                           subscribed.
 */
export class FsChangeListener {
  private subscriptionId: string | null = null;
  private handlerDisposer: (() => void) | null = null;
  /**
   * Last pathMapper passed to subscribe(). Cleared only by the
   * server-aware unsubscribe (= adapter restore), so reconnect can
   * use it to resume against a fresh rpc/adapter pair.
   */
  private lastPathMapper: PathMapper | null = null;

  constructor(private readonly app: App) {}

  /** True if subscribe() ran since the last unsubscribe. */
  hasContext(): boolean {
    return this.lastPathMapper !== null;
  }

  /**
   * Idempotent subscribe. Captures `dataAdapter` + `pathMapper` for the
   * notification handler closure. The first call registers the handler
   * *before* sending fs.watch so we can't miss the daemon's first
   * pushed event.
   */
  async subscribe(opts: {
    rpcConnection: RpcConnection;
    dataAdapter: SftpDataAdapter;
    pathMapper: PathMapper;
  }): Promise<void> {
    if (this.subscriptionId) return;

    this.lastPathMapper = opts.pathMapper;
    const rpc = opts.rpcConnection.rpc;
    const handler = (params: FsChangedParams) =>
      this.handleNotification(params, opts.dataAdapter, opts.pathMapper);
    this.handlerDisposer = rpc.onNotification('fs.changed', handler);

    try {
      const result = await rpc.call('fs.watch', { path: '', recursive: true });
      this.subscriptionId = result.subscriptionId;
      logger.info(`fs.watch subscribed: ${this.subscriptionId}`);
    } catch (e) {
      logger.error(`fs.watch failed: ${(e as Error).message}`);
      this.handlerDisposer?.();
      this.handlerDisposer = null;
    }
  }

  /**
   * Drop local subscription state without notifying the daemon — the
   * underlying SSH session is dead, the daemon will GC the
   * subscription on its own. Keeps `lastPathMapper` so resumeAfterReconnect
   * can resubscribe against the same path scope.
   */
  prepareForReconnect(): void {
    this.subscriptionId = null;
    if (this.handlerDisposer) {
      this.handlerDisposer();
      this.handlerDisposer = null;
    }
  }

  /**
   * Re-subscribe after a successful reconnect, using the pathMapper
   * captured by the most recent subscribe(). No-op if subscribe() was
   * never called or if the subscription is already live (idempotent).
   */
  async resumeAfterReconnect(opts: {
    rpcConnection: RpcConnection;
    dataAdapter: SftpDataAdapter;
  }): Promise<void> {
    if (!this.lastPathMapper) return;
    await this.subscribe({
      rpcConnection: opts.rpcConnection,
      dataAdapter: opts.dataAdapter,
      pathMapper: this.lastPathMapper,
    });
  }

  /**
   * Server-aware unsubscribe: notify the daemon (best-effort) and clear
   * all local state including lastPathMapper. Called from the
   * adapter-restore path. Safe when nothing was subscribed.
   */
  unsubscribe(rpcConnection: RpcConnection | null): void {
    const id = this.subscriptionId;
    this.subscriptionId = null;
    this.lastPathMapper = null;

    if (id && rpcConnection) {
      // Best-effort: if the daemon-side subscription is already gone
      // (process restart, connection drop) the call will reject and
      // we just log it.
      rpcConnection.rpc.call('fs.unwatch', { subscriptionId: id })
        .catch(e => logger.warn(`fs.unwatch failed: ${(e as Error).message}`));
    }
    if (this.handlerDisposer) {
      this.handlerDisposer();
      this.handlerDisposer = null;
    }
  }

  /**
   * Translate a daemon-pushed `fs.changed` notification into a cache
   * invalidation + a vault reconcile. The dataAdapter and pathMapper
   * arguments come from the closure captured at subscribe() time.
   */
  private handleNotification(
    params: FsChangedParams,
    dataAdapter: SftpDataAdapter,
    pathMapper: PathMapper,
  ): void {
    // T4a — first thing the reader sees after the daemon push frame
    // is decoded. Stamping here (before any per-handler short-circuits)
    // gives PerfAggregator the cleanest reader-side latency anchor.
    // M3 will swap perfTracer.newCid() for the cid carried on the
    // notification's envelope meta so this point joins the writer's
    // S.adp/S.rpc spans on the same correlation id.
    perfTracer.point('T4a', perfTracer.newCid(), {
      path: params.path,
      event: params.event,
      subscriptionId: params.subscriptionId,
    });

    if (this.subscriptionId && params.subscriptionId !== this.subscriptionId) {
      return;
    }

    const action = interpretWatchEvent(params.path, pathMapper);
    if (!action) return;

    dataAdapter.invalidateRemotePath(action.remotePath);

    let newVaultPath: string | undefined;
    if (params.event === 'renamed' && params.newPath) {
      const newAction = interpretWatchEvent(params.newPath, pathMapper);
      if (newAction) {
        dataAdapter.invalidateRemotePath(newAction.remotePath);
        newVaultPath = newAction.vaultPath;
      }
    }

    // The notification handler is sync; the model-mutation work
    // ahead is async (we may need to stat through the patched
    // adapter). Fire-and-forget with internal error logging so a
    // failure doesn't bubble back to the RpcClient.
    void this.applyChange(action.vaultPath, newVaultPath, params.event);
  }

  /**
   * Apply one daemon-side filesystem notification to the vault model.
   *
   * Replaces the legacy `reconcileVaultPath` path that drove
   * Obsidian's private `reconcileFile` / `reconcileFolder` API. That
   * API throws on this Obsidian build (the `iu`/`nu` storm of
   * `Cannot read properties of undefined (reading 'startsWith')`).
   * `VaultModelBuilder` mutates the same `vault.fileMap` and fires
   * the same `vault.trigger(create|delete|modify|rename)` events
   * that File Explorer / MetadataCache / Templater / Dataview
   * subscribe to, but does so via an event bus that doesn't trip the
   * broken subscriber chain.
   */
  private async applyChange(
    oldVaultPath: string,
    newVaultPath: string | undefined,
    event: FsChangedParams['event'],
  ): Promise<void> {
    // T4b → T5a — the model-mutation half of the reader-side pipeline.
    // S.app spans the entry into applyChange through every
    // VaultModelBuilder mutator (which emit T5a points just before
    // their `vault.trigger(...)` calls).
    const __t4b = perfTracer.begin('S.app');
    const builder = new VaultModelBuilder(this.app.vault, { TFile, TFolder });

    try {
      switch (event) {
        case 'created': {
          // We need isDirectory + stat. Stat through the patched
          // adapter so PathMapper / cache invalidation are honoured.
          const stat = await this.app.vault.adapter.stat(oldVaultPath).catch(() => null);
          if (!stat) {
            logger.warn(`applyChange(created): stat failed for ${oldVaultPath}`);
            return;
          }
          builder.insertOne({
            path: oldVaultPath,
            isDirectory: stat.type === 'folder',
            ctime: stat.ctime ?? 0,
            mtime: stat.mtime ?? 0,
            size: stat.size ?? 0,
          });
          return;
        }
        case 'deleted': {
          builder.removeOne(oldVaultPath);
          return;
        }
        case 'modified': {
          const stat = await this.app.vault.adapter.stat(oldVaultPath).catch(() => null);
          if (stat) {
            builder.modifyOne(oldVaultPath, {
              ctime: stat.ctime ?? 0,
              mtime: stat.mtime ?? 0,
              size: stat.size ?? 0,
            });
          } else {
            // Stat failed — race with a concurrent delete? Fire the
            // modify event anyway so subscribers know the file
            // changed; absent stat is better than swallowing.
            builder.modifyOne(oldVaultPath);
          }
          return;
        }
        case 'renamed': {
          if (!newVaultPath) {
            logger.warn(`applyChange(renamed): missing newPath for ${oldVaultPath}`);
            return;
          }
          builder.renameOne(oldVaultPath, newVaultPath);
          return;
        }
      }
    } catch (e) {
      logger.warn(`applyChange(${event}) failed for ${oldVaultPath}: ${(e as Error).message}`);
    } finally {
      perfTracer.end(__t4b, { event, path: oldVaultPath, newPath: newVaultPath });
    }
  }
}
