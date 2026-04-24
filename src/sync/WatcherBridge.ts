import type { TAbstractFile, TFile } from 'obsidian';
import type { TransferQueue } from './TransferQueue';
import type { FileIndex } from './FileIndex';
import type { SshProfile } from '../types';
import { UPLOAD_PRIORITY } from '../constants';
import { toLocalPath, toRemotePath, relativeTo } from '../util/pathUtils';
import { logger } from '../util/logger';
import * as fs from 'fs';

export class WatcherBridge {
  constructor(
    private queue: TransferQueue,
    private index: FileIndex,
  ) {}

  onModify(file: TAbstractFile, profile: SshProfile) {
    const localAbs = toLocalPath(profile.localCachePath, (file as TFile).path);
    // Only handle files inside this profile's local cache
    if (!localAbs.startsWith(profile.localCachePath)) return;
    const rel = relativeTo(profile.localCachePath, localAbs);
    if (!rel) return;

    logger.debug_(`WatcherBridge: modify ${rel}`);
    const stat = this.statSync(localAbs);
    this.index.updateLocal(rel, { mtime: stat?.mtime ?? Date.now(), size: stat?.size ?? 0 });

    this.queue.enqueue({
      direction: 'upload',
      relativePath: rel,
      localAbsPath: localAbs,
      remoteAbsPath: toRemotePath(profile.remotePath, rel),
      priority: UPLOAD_PRIORITY,
      retryCount: 0,
    });
  }

  onDelete(file: TAbstractFile, profile: SshProfile) {
    const localAbs = toLocalPath(profile.localCachePath, (file as TFile).path);
    if (!localAbs.startsWith(profile.localCachePath)) return;
    const rel = relativeTo(profile.localCachePath, localAbs);
    if (!rel) return;
    logger.debug_(`WatcherBridge: delete ${rel}`);
    this.index.deleteLocal(rel);
    // Remote delete not implemented in v0.1 (safety first)
  }

  onRename(file: TAbstractFile, oldPath: string, profile: SshProfile) {
    const newLocalAbs = toLocalPath(profile.localCachePath, (file as TFile).path);
    const oldLocalAbs = toLocalPath(profile.localCachePath, oldPath);
    if (!newLocalAbs.startsWith(profile.localCachePath)) return;

    const newRel = relativeTo(profile.localCachePath, newLocalAbs);
    const oldRel = relativeTo(profile.localCachePath, oldLocalAbs);
    if (!newRel || !oldRel) return;

    logger.debug_(`WatcherBridge: rename ${oldRel} → ${newRel}`);
    this.index.deleteLocal(oldRel);
    const stat = this.statSync(newLocalAbs);
    this.index.updateLocal(newRel, { mtime: stat?.mtime ?? Date.now(), size: stat?.size ?? 0 });

    // Use sftp.rename (atomic single op) instead of delete + upload
    this.queue.enqueue({
      direction: 'rename',
      relativePath: newRel,
      localAbsPath: newLocalAbs,
      remoteAbsPath: toRemotePath(profile.remotePath, newRel),
      remoteSrcPath: toRemotePath(profile.remotePath, oldRel),
      priority: UPLOAD_PRIORITY,
      retryCount: 0,
    });
  }

  private statSync(localPath: string): { mtime: number; size: number } | null {
    try {
      const s = fs.statSync(localPath);
      return { mtime: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  }
}
