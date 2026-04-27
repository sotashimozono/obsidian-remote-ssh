import type { RemoteEntry, RemoteStat } from '../types';
import type { SftpClient } from '../ssh/SftpClient';
import type { CloseListener, RemoteFsClient } from './RemoteFsClient';

/**
 * SftpRemoteFsClient adapts the existing `SftpClient` (a direct
 * ssh2/SFTP speaker) to the narrower `RemoteFsClient` interface the
 * adapter now depends on.
 *
 * Every method is a pass-through; the translation exists only so that
 * `SftpDataAdapter` can be agnostic about which client
 * (direct SFTP vs. daemon RPC) is on the other end. When the
 * α (daemon) transport proves out end-to-end, this path can be
 * deprecated; until then it keeps the legacy SFTP code reachable from
 * the new plugin wiring without branching inside the adapter.
 */
export class SftpRemoteFsClient implements RemoteFsClient {
  constructor(private readonly client: SftpClient) {}

  isAlive(): boolean {
    return this.client.isAlive();
  }

  onClose(cb: CloseListener): () => void {
    return this.client.onClose(cb);
  }

  stat(path: string): Promise<RemoteStat> {
    return this.client.stat(path);
  }

  exists(path: string): Promise<boolean> {
    return this.client.exists(path);
  }

  list(path: string): Promise<RemoteEntry[]> {
    return this.client.list(path);
  }

  readBinary(path: string): Promise<Buffer> {
    return this.client.readBinary(path);
  }

  writeBinary(path: string, data: Buffer, _expectedMtime?: number): Promise<void> {
    // SFTP has no atomic precondition surface — there's no way to ask
    // the server "only write if mtime equals N" without a roundtrip
    // race. We accept the argument for interface parity but ignore
    // it; conflict detection is RPC-only.
    return this.client.writeBinary(path, data);
  }

  mkdirp(path: string): Promise<void> {
    return this.client.mkdirp(path);
  }

  remove(path: string): Promise<void> {
    return this.client.remove(path);
  }

  rmdir(path: string, recursive?: boolean): Promise<void> {
    return this.client.rmdir(path, recursive);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.client.rename(oldPath, newPath);
  }

  copy(srcPath: string, destPath: string): Promise<void> {
    return this.client.copy(srcPath, destPath);
  }
}
