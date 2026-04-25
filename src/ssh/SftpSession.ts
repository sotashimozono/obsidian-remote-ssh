import * as fs from 'fs';
import * as path from 'path';
import type { Client, SFTPWrapper } from 'ssh2';
import type { FileEntry } from '../types';
import { TMP_SUFFIX } from '../constants';
import { logger } from '../util/logger';

interface SftpAttrs {
  size: number;
  mtime: number;
  isDirectory(): boolean;
}

interface DirEntry {
  filename: string;
  attrs: SftpAttrs;
}

export class SftpSession {
  private closed = false;

  constructor(private sftp: SFTPWrapper, private client: Client) {
    sftp.on('close', () => { this.closed = true; });
  }

  get isAlive(): boolean { return !this.closed; }

  async stat(remotePath: string): Promise<SftpAttrs> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(remotePath, (err, stats) => err ? reject(err) : resolve(stats as unknown as SftpAttrs));
    });
  }

  async readdir(remotePath: string): Promise<DirEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(remotePath, (err, list) =>
        err ? reject(err) : resolve(list as unknown as DirEntry[])
      );
    });
  }

  async listRecursive(
    remoteDir: string,
    filter?: (rel: string) => boolean,
    followSymlinks = false,
  ): Promise<FileEntry[]> {
    const results: FileEntry[] = [];
    const queue: string[] = [remoteDir];
    const visited = new Set<string>(); // guard against symlink cycles

    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: DirEntry[];
      try {
        entries = await this.readdir(dir);
      } catch (e) {
        logger.warn(`listRecursive: cannot readdir "${dir}": ${(e as Error).message}`);
        continue;
      }

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        const fullPath = `${dir}/${entry.filename}`;
        const rel = fullPath.slice(remoteDir.length + 1);
        if (filter && !filter(rel)) continue;

        let attrs = entry.attrs;
        if (followSymlinks) {
          try {
            attrs = await this.stat(fullPath) as SftpAttrs;
          } catch {
            // Dangling symlink — skip
            logger.warn(`listRecursive: dangling symlink at "${fullPath}", skipping`);
            continue;
          }
        }

        if (attrs.isDirectory()) {
          if (visited.has(fullPath)) continue; // cycle guard
          visited.add(fullPath);
          results.push({ relativePath: rel, mtime: attrs.mtime * 1000, size: 0, isDirectory: true });
          queue.push(fullPath);
        } else {
          results.push({ relativePath: rel, mtime: attrs.mtime * 1000, size: attrs.size, isDirectory: false });
        }
      }
    }
    return results;
  }

  async fastGet(remotePath: string, localPath: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    return new Promise((resolve, reject) => {
      this.sftp.fastGet(remotePath, localPath, { concurrency: 8, chunkSize: 32768 }, err =>
        err ? reject(err) : resolve()
      );
    });
  }

  async fastPut(localPath: string, remotePath: string): Promise<void> {
    const tmpPath = remotePath + TMP_SUFFIX;
    await new Promise<void>((resolve, reject) => {
      this.sftp.fastPut(localPath, tmpPath, { concurrency: 8 }, err =>
        err ? reject(err) : resolve()
      );
    });
    await this.rename(tmpPath, remotePath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sftpAny = this.sftp as any;
      if (sftpAny._extensions?.['posix-rename@openssh.com']) {
        sftpAny.ext_openssh_rename(oldPath, newPath, (err: Error) =>
          err ? reject(err) : resolve()
        );
      } else {
        this.sftp.rename(oldPath, newPath, err => err ? reject(err) : resolve());
      }
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.mkdir(remotePath, err => {
        if (err && !(err.message.toLowerCase().includes('exist'))) reject(err);
        else resolve();
      });
    });
  }

  async unlink(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.unlink(remotePath, err => err ? reject(err) : resolve());
    });
  }

  async mkdirp(remotePath: string): Promise<void> {
    const parts = remotePath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      await this.mkdir(current);
    }
  }
}
