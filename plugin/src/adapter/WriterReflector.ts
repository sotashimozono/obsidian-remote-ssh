/**
 * Callback surface the `SftpDataAdapter` invokes after a
 * local-originated mutation succeeds, so the writer's own in-memory
 * vault model — `vault.fileMap` plus the `vault.trigger(...)` event
 * bus that File Explorer, MetadataCache and open editor tabs all
 * subscribe to — reflects the change without waiting for a
 * remote-driven echo.
 *
 * Issue #341: a title-bar rename calls `adapter.rename(old, new)`,
 * the remote op succeeds, but nothing fires `vault.trigger('rename')`
 * on the writer side, so the open editor tab stays bound to the
 * stale `TFile` and the next save targets a path that no longer
 * exists. On the SFTP transport there is no daemon `fs.watch` push
 * to recover from, so the divergence is permanent.
 *
 * `VaultModelBuilder` already maintains exactly this model for
 * remote-originated changes (driven by `FsChangeListener`); it
 * structurally satisfies this interface, so the writer path reuses
 * it. The interface lives in `adapter/` and is referenced only
 * structurally from `vault/`, so wiring it introduces no
 * adapter → vault import edge.
 */
export interface WriterReflector {
  /**
   * After `write` / `writeBinary`: insert the `TFile` and fire
   * `create` when the path is new, otherwise fire `modify`.
   * `stat` is the post-write stat, when available.
   */
  reflectWrite(path: string, stat?: WrittenStat): void;

  /**
   * Drop Obsidian's cached copy of the file's text, so the next cachedRead
   * goes through the adapter: the write put other text on the remote than
   * the caller handed in.
   */
  forgetText(path: string): void;

  /**
   * After `rename`: move the entry between `fileMap` keys and fire
   * `vault.trigger('rename', file, oldPath)`.
   */
  reflectRename(oldPath: string, newPath: string): void;

  /**
   * After `remove` / `rmdir`: drop the entry (and descendants, for a
   * folder) and fire `vault.trigger('delete', file)`.
   */
  reflectRemove(path: string): void;

  /**
   * After `mkdir`: insert the `TFolder` when absent and fire
   * `vault.trigger('create', folder)`.
   */
  reflectMkdir(path: string): void;
}

/**
 * The remote's post-write stat (unix ms, bytes). The daemon's echo of a
 * local write is dropped as self-originated, so this is what refreshes
 * `TFile.stat`.
 */
export interface WrittenStat {
  mtime: number;
  size: number;
}
