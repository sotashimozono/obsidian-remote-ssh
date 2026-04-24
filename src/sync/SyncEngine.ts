import * as fs from 'fs';
import * as path from 'path';
import type { App, Plugin } from 'obsidian';
import type { SshProfile, TransferJob, ConflictDecision, FileEntry } from '../types';
import { SyncState } from '../types';
import { DOWNLOAD_PRIORITY, UPLOAD_PRIORITY } from '../constants';
import { ConnectionPool } from '../ssh/ConnectionPool';
import { FileIndex } from './FileIndex';
import { DiffCalculator } from './DiffCalculator';
import { TransferQueue } from './TransferQueue';
import { IgnoreFilter } from './IgnoreFilter';
import { WatcherBridge } from './WatcherBridge';
import { toLocalPath, toRemotePath } from '../util/pathUtils';
import { logger } from '../util/logger';

type StateListener = (state: SyncState) => void;

export class SyncEngine {
  private state: SyncState = SyncState.IDLE;
  private stateListeners: StateListener[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private profile: SshProfile | null = null;
  private vaultEventRefs: (() => void)[] = [];

  readonly index = new FileIndex();
  readonly queue = new TransferQueue();
  readonly filter: IgnoreFilter;
  readonly watcher: WatcherBridge;

  constructor(
    private pool: ConnectionPool,
    private app: App,
    private plugin: Plugin,
  ) {
    this.filter = new IgnoreFilter([]);
    this.watcher = new WatcherBridge(this.queue, this.index);

    this.queue.setHandler(job => this.executeTransfer(job));
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.push(fn);
    return () => { this.stateListeners = this.stateListeners.filter(l => l !== fn); };
  }

  getState(): SyncState { return this.state; }

  private setState(s: SyncState) {
    this.state = s;
    this.stateListeners.forEach(fn => fn(s));
  }

  async connect(profile: SshProfile, indexPath: string) {
    if (this.state !== SyncState.IDLE && this.state !== SyncState.ERROR) {
      logger.warn('SyncEngine.connect called in non-idle state');
      return;
    }

    this.profile = profile;
    this.filter.setPatterns(profile.ignorePatterns);

    this.index.setIndexPath(indexPath);
    await this.index.load();

    this.setState(SyncState.CONNECTING);
    try {
      await this.pool.getOrCreate(profile);
    } catch (e) {
      logger.error(`Connect failed: ${(e as Error).message}`);
      this.setState(SyncState.ERROR);
      throw e;
    }

    this.setState(SyncState.INITIAL_PULL);
    await this.initialPull(profile);

    this.registerVaultEvents(profile);

    if (profile.autoSync && profile.pollIntervalSec > 0) {
      this.startPolling(profile);
    }

    this.setState(SyncState.WATCHING);
  }

  async disconnect() {
    this.setState(SyncState.DISCONNECTING);
    this.stopPolling();
    this.unregisterVaultEvents();
    if (this.profile) {
      this.pool.destroy(this.profile.id);
    }
    this.queue.clear();
    await this.index.persist();
    this.profile = null;
    this.setState(SyncState.IDLE);
  }

  async forceFullSync() {
    if (!this.profile) return;
    logger.info('Force full sync requested');
    this.setState(SyncState.SYNCING);
    await this.poll(this.profile);
    this.setState(SyncState.WATCHING);
  }

  private async initialPull(profile: SshProfile) {
    logger.info(`Initial pull from ${profile.remotePath} → ${profile.localCachePath}`);
    const session = await this.pool.getOrCreate(profile);

    let remoteEntries: FileEntry[];
    try {
      remoteEntries = await session.listRecursive(
        profile.remotePath,
        rel => !this.filter.shouldIgnore(rel),
      );
    } catch (e) {
      logger.error(`Initial pull: listRecursive failed: ${(e as Error).message}`);
      throw e;
    }

    this.index.setRemoteEntries(remoteEntries);

    const files = remoteEntries.filter(e => !e.isDirectory);
    logger.info(`Initial pull: ${files.length} files to check`);

    const jobs: TransferJob[] = [];
    for (const entry of files) {
      const localAbs = toLocalPath(profile.localCachePath, entry.relativePath);
      const localExists = await fs.promises.access(localAbs).then(() => true).catch(() => false);

      let needsDownload = !localExists;
      if (localExists) {
        const localStat = await fs.promises.stat(localAbs).catch(() => null);
        if (localStat && Math.abs(localStat.mtimeMs - entry.mtime) > 2000) {
          needsDownload = true;
        }
      }

      if (needsDownload) {
        jobs.push({
          direction: 'download',
          relativePath: entry.relativePath,
          localAbsPath: localAbs,
          remoteAbsPath: toRemotePath(profile.remotePath, entry.relativePath),
          priority: DOWNLOAD_PRIORITY,
          retryCount: 0,
        });
      } else {
        // Update local index from disk
        const s = await fs.promises.stat(localAbs).catch(() => null);
        if (s) this.index.updateLocal(entry.relativePath, { mtime: s.mtimeMs, size: s.size });
      }
    }

    logger.info(`Initial pull: downloading ${jobs.length} files`);
    this.queue.bulkEnqueue(jobs);
    await this.waitIdle();
    await this.index.persist();
    logger.info('Initial pull complete');
  }

  private async poll(profile: SshProfile) {
    logger.info('Polling remote for changes...');
    const session = await this.pool.getOrCreate(profile);
    const remoteEntries = await session.listRecursive(
      profile.remotePath,
      rel => !this.filter.shouldIgnore(rel),
    );

    const diff = new DiffCalculator(this.index);
    const changeSet = diff.compute(remoteEntries);

    if (changeSet.conflicts.length > 0) {
      this.setState(SyncState.CONFLICTED);
      // Emit event for UI to show ConflictModal — handled via onConflict callback
      if (this.onConflict) {
        const decisions = await this.onConflict(changeSet.conflicts);
        await this.applyConflictDecisions(decisions, changeSet.conflicts, profile);
      }
      this.setState(SyncState.SYNCING);
    }

    const jobs: TransferJob[] = [
      ...changeSet.toDownload.map(e => ({
        direction: 'download' as const,
        relativePath: e.relativePath,
        localAbsPath: toLocalPath(profile.localCachePath, e.relativePath),
        remoteAbsPath: toRemotePath(profile.remotePath, e.relativePath),
        priority: DOWNLOAD_PRIORITY,
        retryCount: 0,
      })),
    ];

    this.queue.bulkEnqueue(jobs);

    // Delete files removed from remote
    for (const rel of changeSet.toDeleteLocal) {
      const localAbs = toLocalPath(profile.localCachePath, rel);
      await fs.promises.unlink(localAbs).catch(() => {});
      this.index.deleteLocal(rel);
      this.index.deleteRemote(rel);
    }

    await this.waitIdle();
    this.index.setRemoteEntries(remoteEntries);
    await this.index.persist();
  }

  onConflict: ((conflicts: import('../types').ConflictEntry[]) => Promise<Map<string, ConflictDecision>>) | null = null;

  private async applyConflictDecisions(
    decisions: Map<string, ConflictDecision>,
    conflicts: import('../types').ConflictEntry[],
    profile: SshProfile,
  ) {
    const session = await this.pool.getOrCreate(profile);
    for (const conflict of conflicts) {
      const decision = decisions.get(conflict.relativePath) ?? 'keepRemote';
      const localAbs  = toLocalPath(profile.localCachePath, conflict.relativePath);
      const remoteAbs = toRemotePath(profile.remotePath, conflict.relativePath);

      if (decision === 'keepRemote') {
        this.queue.enqueue({
          direction: 'download', relativePath: conflict.relativePath,
          localAbsPath: localAbs, remoteAbsPath: remoteAbs,
          priority: UPLOAD_PRIORITY + 1, retryCount: 0,
        });
      } else if (decision === 'keepLocal') {
        this.queue.enqueue({
          direction: 'upload', relativePath: conflict.relativePath,
          localAbsPath: localAbs, remoteAbsPath: remoteAbs,
          priority: UPLOAD_PRIORITY + 1, retryCount: 0,
        });
      } else {
        // keepBoth: rename local to .conflict, then download remote
        const ext   = path.extname(localAbs);
        const base  = localAbs.slice(0, -ext.length);
        const dest  = `${base}.conflict${ext}`;
        await fs.promises.rename(localAbs, dest).catch(() => {});
        this.queue.enqueue({
          direction: 'download', relativePath: conflict.relativePath,
          localAbsPath: localAbs, remoteAbsPath: remoteAbs,
          priority: UPLOAD_PRIORITY + 1, retryCount: 0,
        });
      }
    }
  }

  private async executeTransfer(job: TransferJob) {
    const session = await this.pool.getOrCreate(this.profile!);
    if (job.direction === 'download') {
      logger.debug_(`↓ ${job.relativePath}`);
      await session.fastGet(job.remoteAbsPath, job.localAbsPath);
      const s = await fs.promises.stat(job.localAbsPath);
      this.index.updateLocal(job.relativePath, { mtime: s.mtimeMs, size: s.size });
      this.index.updateRemote(job.relativePath, { mtime: s.mtimeMs, size: s.size });
    } else {
      logger.debug_(`↑ ${job.relativePath}`);
      const remoteDir = job.remoteAbsPath.split('/').slice(0, -1).join('/');
      await session.mkdirp(remoteDir);
      await session.fastPut(job.localAbsPath, job.remoteAbsPath);
      const s = await fs.promises.stat(job.localAbsPath);
      this.index.updateLocal(job.relativePath, { mtime: s.mtimeMs, size: s.size });
      this.index.updateRemote(job.relativePath, { mtime: s.mtimeMs, size: s.size });
    }
    this.notifyActivity();
  }

  private notifyActivity() {
    if (this.state === SyncState.WATCHING && !this.queue.isIdle) {
      this.setState(SyncState.SYNCING);
    } else if (this.state === SyncState.SYNCING && this.queue.isIdle) {
      this.setState(SyncState.WATCHING);
    }
  }

  private startPolling(profile: SshProfile) {
    this.pollTimer = setInterval(async () => {
      if (this.state !== SyncState.WATCHING) return;
      this.setState(SyncState.SYNCING);
      try {
        await this.poll(profile);
      } catch (e) {
        logger.error(`Poll error: ${(e as Error).message}`);
      } finally {
        if ((this.state as SyncState) === SyncState.SYNCING) this.setState(SyncState.WATCHING);
      }
    }, profile.pollIntervalSec * 1000);
  }

  private stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private registerVaultEvents(profile: SshProfile) {
    const onModify = this.app.vault.on('modify', (file) => {
      this.watcher.onModify(file, profile);
    });
    const onDelete = this.app.vault.on('delete', (file) => {
      this.watcher.onDelete(file, profile);
    });
    const onRename = this.app.vault.on('rename', (file, oldPath) => {
      this.watcher.onRename(file, oldPath, profile);
    });
    const unregister = () => {
      this.app.vault.offref(onModify);
      this.app.vault.offref(onDelete);
      this.app.vault.offref(onRename);
    };
    this.vaultEventRefs = [unregister];
  }

  private unregisterVaultEvents() {
    this.vaultEventRefs.forEach(fn => fn());
    this.vaultEventRefs = [];
  }

  private waitIdle(): Promise<void> {
    return new Promise(resolve => {
      if (this.queue.isIdle) { resolve(); return; }
      const check = setInterval(() => {
        if (this.queue.isIdle) { clearInterval(check); resolve(); }
      }, 200);
    });
  }
}
