import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RemoteEntry } from './VaultModelBuilder';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';
import { writeFileAtomic } from '../util/writeFileAtomic';

/**
 * A per-device copy of the remote TREE (paths + mtime + size, never content),
 * so the next launch can put the vault model back before Obsidian's
 * `metadataCache.initialize()` runs (#513).
 *
 * ## Why this has to exist
 *
 * Obsidian's startup order is `plugins.initialize()` (our `onload`) →
 * `vault.load()` → `metadataCache.initialize()`. That last step walks its
 * IndexedDB cache and, for every cached path that is NOT in the vault model at
 * that moment, calls `deletePath()`, which also deletes it from IndexedDB. The
 * shadow vault's disk holds no notes, and the remote tree only arrives after
 * connect (layout ready or later), so on every start Obsidian threw its whole
 * cache away and then re-read and re-parsed every note once we registered it.
 * Measured by `e2e/scale.spec.ts`: ~23 notes/s, the same on a relaunch as on a
 * cold start.
 *
 * Inserting the tree from here, during `onload`, means `initialize()` finds
 * every note with the same `mtime`/`size` it cached, keeps the entry, and does
 * not read it. The tree is then reconciled against the real remote walk after
 * connect (`BackgroundIndexer`'s reconcile), so a stale snapshot costs a
 * re-read of what changed, never wrong state.
 *
 * Only written after a daemon `fs.walk` (the fast path): the SFTP fallback
 * reports `mtime`/`size` as 0, and a snapshot of zeros would make Obsidian
 * treat every note as unchanged forever.
 *
 * Lives beside `community-plugins.base.json` in
 * `~/.obsidian-remote/state/<profile>/`: per-device, never synced, outside
 * every vault (see `communityPluginsBasePath` in CommunityPluginsSync).
 */

const VERSION = 2;

/**
 * Refuse a snapshot bigger than any real vault this plugin can serve. It is
 * read synchronously inside `onload`, which Obsidian awaits before it starts
 * the vault, so a corrupt or inflated file would delay every launch.
 */
const MAX_ENTRIES = 500_000;

/** One entry, packed: `[path, isDirectory ? 1 : 0, mtime, size, ctime]`. ~65 bytes a note. */
type PackedEntry = [string, 0 | 1, number, number, number];

interface SnapshotFile {
  version: number;
  /** The profile's `remotePath` when this was taken. A different path is a different vault. */
  remotePath: string;
  entries: PackedEntry[];
}

export function treeSnapshotPath(stateRoot: string, stateKey: string): string {
  return path.join(stateRoot, 'state', stateKey, 'tree-snapshot.json');
}

/**
 * A vault-relative path the live walker would also accept. The snapshot is
 * only ever written from an already-filtered model, but it is a plain file in
 * the user's home: a hand-edited one must not be able to put `..`, an
 * absolute path or the config dir into the vault model.
 */
function isUsablePath(p: string, configDir: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\')) return false;
  if (p === configDir || p.startsWith(configDir + '/')) return false;
  return p.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

/**
 * The snapshot's entries, parents before children, or null when there is none,
 * it is unreadable, or it was taken for a different `remotePath`. Synchronous
 * on purpose: it runs inside `onload`, which Obsidian awaits before
 * `metadataCache.initialize()`.
 */
export function readTreeSnapshot(file: string, remotePath: string, configDir: string): RemoteEntry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SnapshotFile>;
    if (parsed.version !== VERSION || parsed.remotePath !== remotePath || !Array.isArray(parsed.entries)) {
      return null;
    }
    if (parsed.entries.length > MAX_ENTRIES) {
      logger.warn(`TreeSnapshot: ignoring ${file} — ${parsed.entries.length} entries is past the ${MAX_ENTRIES} cap`);
      return null;
    }
    const entries: RemoteEntry[] = [];
    let rejected = 0;
    for (const e of parsed.entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !isUsablePath(e[0], configDir)) {
        rejected++;
        continue;
      }
      if (typeof e[2] !== 'number' || typeof e[3] !== 'number' || typeof e[4] !== 'number') {
        rejected++;
        continue;
      }
      entries.push({ path: e[0], isDirectory: e[1] === 1, ctime: e[4], mtime: e[2], size: e[3] });
    }
    if (rejected > 0) logger.warn(`TreeSnapshot: dropped ${rejected} unusable entries from ${file}`);
    return entries;
  } catch (e) {
    logger.warn(`TreeSnapshot: ignoring unreadable ${file} (${errorMessage(e)})`);
    return null;
  }
}

/** Write atomically (tmp + rename), so a crash mid-write leaves the old snapshot. */
export function writeTreeSnapshot(file: string, remotePath: string, entries: readonly RemoteEntry[]): void {
  const body: SnapshotFile = {
    version: VERSION,
    remotePath,
    entries: entries.map((e) => [e.path, e.isDirectory ? 1 : 0, e.mtime, e.size, e.ctime]),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // This was a fourth hand-written copy of tmp+rename, and the only one that
  // never unlinked the temp file when the rename failed.
  writeFileAtomic(file, JSON.stringify(body));
}

export function deleteTreeSnapshot(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

/** The shape of `vault.getAllLoadedFiles()` entries this needs. */
export interface LoadedFileLike {
  path: string;
  stat?: { ctime?: number; mtime: number; size: number };
  children?: unknown[];
}

/**
 * The vault model as snapshot entries, parents before children. Leaves out the
 * root and the config dir: the root always exists, and `<configDir>` lives on
 * the shadow disk and is never part of the remote note tree.
 */
export function collectModelEntries(files: readonly LoadedFileLike[], configDir: string): RemoteEntry[] {
  const out: RemoteEntry[] = [];
  for (const f of files) {
    if (!f.path || f.path === '/') continue;
    if (f.path === configDir || f.path.startsWith(configDir + '/')) continue;
    const isDirectory = Array.isArray(f.children);
    out.push({
      path: f.path,
      isDirectory,
      ctime: isDirectory ? 0 : f.stat?.ctime ?? f.stat?.mtime ?? 0,
      mtime: isDirectory ? 0 : f.stat?.mtime ?? 0,
      size: isDirectory ? 0 : f.stat?.size ?? 0,
    });
  }
  const depth = (p: string) => p.split('/').length;
  out.sort((a, b) => depth(a.path) - depth(b.path) || Number(b.isDirectory) - Number(a.isDirectory));
  return out;
}
