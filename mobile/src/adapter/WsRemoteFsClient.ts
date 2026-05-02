import { WsRpcClient } from '../transport/WsRpcClient.js';

// ─── DTO shapes (mirror next/proto/types.ts) ─────────────────────────────────

interface Stat {
  type: 'file' | 'folder';
  mtime: number;
  size: number;
  mode: number;
}

interface Entry {
  name: string;
  type: 'file' | 'folder' | 'symlink';
  mtime: number;
  size: number;
}

// ─── Public shapes ────────────────────────────────────────────────────────────

export interface RemoteStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mtime: number;
  size: number;
  mode: number;
}

export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mtime: number;
  size: number;
}

export type CloseListener = (event: { unexpected: boolean }) => void;

/**
 * WsRemoteFsClient speaks to the Go daemon via WsRpcClient over a
 * browser WebSocket + relay. It mirrors RpcRemoteFsClient (desktop)
 * but uses Uint8Array / base64 instead of Node.js Buffer.
 */
export class WsRemoteFsClient {
  constructor(private readonly rpc: WsRpcClient) {}

  // ─── lifecycle ─────────────────────────────────────────────────────────

  isAlive(): boolean {
    return !this.rpc.isClosed();
  }

  onClose(cb: CloseListener): () => void {
    return this.rpc.onClose((err) => cb({ unexpected: err !== undefined }));
  }

  // ─── read side ─────────────────────────────────────────────────────────

  async stat(path: string): Promise<RemoteStat> {
    const s = await this.rpc.call('fs.stat', { path }) as Stat | null;
    if (s === null) {
      throw Object.assign(new Error(`no such file: ${path}`), { code: -32020 });
    }
    return toRemoteStat(s);
  }

  async exists(path: string): Promise<boolean> {
    const r = await this.rpc.call('fs.exists', { path }) as { exists: boolean };
    return r.exists;
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const r = await this.rpc.call('fs.list', { path }) as { entries: Entry[] };
    return r.entries.map(toRemoteEntry);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const r = await this.rpc.call('fs.readBinary', { path }) as { contentBase64: string };
    return b64ToUint8Array(r.contentBase64);
  }

  async readBinaryRange(
    path: string,
    offset: number,
    length: number,
    expectedMtime?: number,
  ): Promise<{ data: Uint8Array; mtime: number; size: number }> {
    const r = await this.rpc.call('fs.readBinaryRange', {
      path, offset, length,
      ...(expectedMtime !== undefined ? { expectedMtime } : {}),
    }) as { contentBase64: string; mtime: number; size: number };
    return { data: b64ToUint8Array(r.contentBase64), mtime: r.mtime, size: r.size };
  }

  // ─── write side ────────────────────────────────────────────────────────

  async writeBinary(path: string, data: Uint8Array, expectedMtime?: number): Promise<void> {
    await this.rpc.call('fs.writeBinary', {
      path,
      contentBase64: uint8ArrayToB64(data),
      ...(expectedMtime !== undefined ? { expectedMtime } : {}),
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

// ─── DTO converters ──────────────────────────────────────────────────────────

function toRemoteStat(s: Stat): RemoteStat {
  return {
    isDirectory:    s.type === 'folder',
    isFile:         s.type === 'file',
    isSymbolicLink: false,
    mtime:          s.mtime,
    size:           s.size,
    mode:           s.mode,
  };
}

function toRemoteEntry(e: Entry): RemoteEntry {
  return {
    name:           e.name,
    isDirectory:    e.type === 'folder',
    isFile:         e.type === 'file',
    isSymbolicLink: e.type === 'symlink',
    mtime:          e.mtime,
    size:           e.size,
  };
}

// ─── base64 helpers ──────────────────────────────────────────────────────────

function uint8ArrayToB64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function b64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
