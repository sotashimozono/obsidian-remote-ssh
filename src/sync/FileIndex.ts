import * as fs from 'fs';
import * as path from 'path';
import type { FileEntry } from '../types';
import { logger } from '../util/logger';

interface IndexData {
  local: Record<string, { mtime: number; size: number }>;
  remote: Record<string, { mtime: number; size: number }>;
}

export class FileIndex {
  private local: Map<string, { mtime: number; size: number }> = new Map();
  private remote: Map<string, { mtime: number; size: number }> = new Map();

  private indexPath: string | null = null;

  setIndexPath(p: string) { this.indexPath = p; }

  updateLocal(relativePath: string, entry: { mtime: number; size: number }) {
    this.local.set(relativePath, entry);
  }

  updateRemote(relativePath: string, entry: { mtime: number; size: number }) {
    this.remote.set(relativePath, entry);
  }

  deleteLocal(relativePath: string) { this.local.delete(relativePath); }
  deleteRemote(relativePath: string) { this.remote.delete(relativePath); }

  getLocal(relativePath: string) { return this.local.get(relativePath); }
  getRemote(relativePath: string) { return this.remote.get(relativePath); }

  setRemoteEntries(entries: FileEntry[]) {
    this.remote.clear();
    for (const e of entries) {
      if (!e.isDirectory) this.remote.set(e.relativePath, { mtime: e.mtime, size: e.size });
    }
  }

  setLocalEntries(entries: FileEntry[]) {
    this.local.clear();
    for (const e of entries) {
      if (!e.isDirectory) this.local.set(e.relativePath, { mtime: e.mtime, size: e.size });
    }
  }

  allRemotePaths(): string[] { return [...this.remote.keys()]; }
  allLocalPaths(): string[] { return [...this.local.keys()]; }

  async persist() {
    if (!this.indexPath) return;
    const data: IndexData = {
      local: Object.fromEntries(this.local),
      remote: Object.fromEntries(this.remote),
    };
    try {
      await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true });
      await fs.promises.writeFile(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.warn(`FileIndex: persist failed: ${(e as Error).message}`);
    }
  }

  async load() {
    if (!this.indexPath) return;
    try {
      const raw = await fs.promises.readFile(this.indexPath, 'utf-8');
      const data: IndexData = JSON.parse(raw);
      this.local = new Map(Object.entries(data.local ?? {}));
      this.remote = new Map(Object.entries(data.remote ?? {}));
      logger.info(`FileIndex: loaded ${this.local.size} local + ${this.remote.size} remote entries`);
    } catch {
      // First run or corrupted — start fresh
    }
  }
}
