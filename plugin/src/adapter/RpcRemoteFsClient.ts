import type { RemoteEntry, RemoteStat } from '../types';
import type { RpcClient } from '../transport/RpcClient';
import type { CloseListener, RemoteFsClient } from './RemoteFsClient';
import type { Entry, Stat } from '../proto/types';
import { RpcError } from '../transport/RpcError';

/**
 * RpcRemoteFsClient speaks to the Go daemon (obsidian-remote-server)
 * via a JSON-RPC client over an SSH-tunnelled socket.
 *
 * The adapter doesn't have to know about atomicity — the server
 * handles `fs.write` with a tmp+rename on its side — so this class
 * just forwards each call and re-shapes the DTO from `proto/types.ts`
 * into the `RemoteStat` / `RemoteEntry` shapes the plugin already
 * uses elsewhere.
 */
export class RpcRemoteFsClient implements RemoteFsClient {
  constructor(private readonly rpc: RpcClient) {}

  // ─── lifecycle ─────────────────────────────────────────────────────────

  isAlive(): boolean {
    return !this.rpc.isClosed();
  }

  onClose(cb: CloseListener): () => void {
    return this.rpc.onClose((err) => cb({ unexpected: err !== undefined }));
  }

  // ─── read side ────────────────────────────────────────────────────────

  async stat(path: string): Promise<RemoteStat> {
    const s = await this.rpc.call('fs.stat', { path });
    if (s === null) {
      // The daemon returns null for "missing"; surface the same not-found
      // signal clients expect from the SFTP client.
      throw new RpcError(-32010, `no such file: ${path}`);
    }
    return toRemoteStat(s);
  }

  async exists(path: string): Promise<boolean> {
    const r = await this.rpc.call('fs.exists', { path });
    return r.exists;
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const r = await this.rpc.call('fs.list', { path });
    return r.entries.map(toRemoteEntry);
  }

  async readBinary(path: string): Promise<Buffer> {
    const r = await this.rpc.call('fs.readBinary', { path });
    return Buffer.from(r.contentBase64, 'base64');
  }

  // ─── write side ───────────────────────────────────────────────────────

  async writeBinary(path: string, data: Buffer): Promise<void> {
    await this.rpc.call('fs.writeBinary', {
      path,
      contentBase64: data.toString('base64'),
    });
  }

  async mkdirp(path: string): Promise<void> {
    await this.rpc.call('fs.mkdir', { path, recursive: true });
  }

  async remove(path: string): Promise<void> {
    await this.rpc.call('fs.remove', { path });
  }

  async rmdir(path: string, recursive = false): Promise<void> {
    await this.rpc.call('fs.rmdir', { path, recursive });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.rpc.call('fs.rename', { oldPath, newPath });
  }

  async copy(srcPath: string, destPath: string): Promise<void> {
    await this.rpc.call('fs.copy', { srcPath, destPath });
  }
}

// ─── DTO converters ──────────────────────────────────────────────────────

function toRemoteStat(s: Stat): RemoteStat {
  return {
    isDirectory:     s.type === 'folder',
    isFile:          s.type === 'file',
    isSymbolicLink:  false, // fs.stat follows the link; symlink detection lives in list()
    mtime:           s.mtime,
    size:            s.size,
    mode:            s.mode,
  };
}

function toRemoteEntry(e: Entry): RemoteEntry {
  return {
    name:            e.name,
    isDirectory:     e.type === 'folder',
    isFile:          e.type === 'file',
    isSymbolicLink:  e.type === 'symlink',
    mtime:           e.mtime,
    size:            e.size,
  };
}
