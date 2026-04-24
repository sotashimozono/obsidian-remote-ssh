import type { FileEntry, ChangeSet, ConflictEntry } from '../types';
import type { FileIndex } from './FileIndex';

const MTIME_TOLERANCE_MS = 2000;

export class DiffCalculator {
  constructor(private index: FileIndex) {}

  compute(remoteEntries: FileEntry[]): ChangeSet {
    const toDownload: FileEntry[] = [];
    const toUpload: string[] = [];
    const toDeleteLocal: string[] = [];
    const conflicts: ConflictEntry[] = [];

    const remoteMap = new Map<string, FileEntry>();
    for (const e of remoteEntries) {
      if (!e.isDirectory) remoteMap.set(e.relativePath, e);
    }

    // Remote → local: what needs downloading or conflict check
    for (const [rel, remote] of remoteMap) {
      const knownRemote = this.index.getRemote(rel);
      const knownLocal  = this.index.getLocal(rel);

      const remoteChanged = !knownRemote || Math.abs(remote.mtime - knownRemote.mtime) > MTIME_TOLERANCE_MS;
      const localChanged  = knownLocal !== undefined;

      if (!knownLocal && !knownRemote) {
        // New file on remote
        toDownload.push(remote);
      } else if (remoteChanged && !localChanged) {
        // Remote updated, local untouched
        toDownload.push(remote);
      } else if (remoteChanged && localChanged) {
        // Both changed — conflict
        conflicts.push({
          relativePath: rel,
          localMtime: knownLocal!.mtime,
          remoteMtime: remote.mtime,
          localSize: knownLocal!.size,
          remoteSize: remote.size,
        });
      }
      // else: remote unchanged → no action needed
    }

    // Local → remote: files in local index not on remote
    for (const rel of this.index.allLocalPaths()) {
      if (!remoteMap.has(rel)) {
        toUpload.push(rel);
      }
    }

    // Files that existed on remote but are gone now → delete local
    for (const rel of this.index.allRemotePaths()) {
      if (!remoteMap.has(rel)) {
        toDeleteLocal.push(rel);
      }
    }

    return { toDownload, toUpload, toDeleteLocal, conflicts };
  }
}
