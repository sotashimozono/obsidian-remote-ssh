import type { RemoteEntry, RemoteStat } from '../types';

/**
 * The surface `SftpDataAdapter` (and friends) need from whatever is
 * talking to the remote filesystem. Two implementations live in the
 * tree:
 *
 *  - `RpcRemoteFsClient` — JSON-RPC to obsidian-remote-server (the
 *    primary / α path; added in Phase 5-D).
 *  - `SftpRemoteFsClient` — the existing direct-SFTP client kept as
 *    a fallback until the α path proves out (Phase 5-D.2 will wrap
 *    the current `SftpClient`).
 *
 * The interface is deliberately narrow: it mirrors what the adapter
 * actually calls, not the full SFTP command set. New methods arrive
 * here only when the adapter needs them.
 */
export interface RemoteFsClient {
  // ─── lifecycle ─────────────────────────────────────────────────────────
  /** Active connection check. */
  isAlive(): boolean;

  /** Register a disconnection listener. The callback fires once. */
  onClose(cb: CloseListener): () => void;

  // ─── read side ────────────────────────────────────────────────────────
  stat(path: string): Promise<RemoteStat>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<RemoteEntry[]>;
  readBinary(path: string): Promise<Buffer>;

  // ─── write side ───────────────────────────────────────────────────────
  /**
   * Atomic on the server; clients should not wrap in their own tmp+rename.
   *
   * `expectedMtime`, if provided, asks the server to reject the write
   * with `PreconditionFailed` (-32020) when the remote mtime no longer
   * matches — used by `SftpDataAdapter.writeBuffer` to detect
   * concurrent edits from another client. Implementations that can't
   * enforce a precondition (the direct-SFTP wrapper) should ignore the
   * argument; conflict detection is a best-effort feature, not a
   * correctness invariant.
   */
  writeBinary(path: string, data: Buffer, expectedMtime?: number): Promise<void>;

  /** Ensure a directory chain exists (idempotent). */
  mkdirp(path: string): Promise<void>;

  /** File-only remove. Directories must go through `rmdir`. */
  remove(path: string): Promise<void>;

  rmdir(path: string, recursive?: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copy(srcPath: string, destPath: string): Promise<void>;
}

/** Called with `{unexpected:true}` when the connection dropped without a clean disconnect. */
export type CloseListener = (info: { unexpected: boolean }) => void;
