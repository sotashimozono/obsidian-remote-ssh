import * as nodePath from 'path';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/** One entry of the vault model, as the filesystem needs to see it. */
export interface VaultEntry {
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Read-only window onto `vault.fileMap` — names and stats only. It is
 * free: the model already holds the whole remote tree (the background
 * indexer fills it), so listing a directory or stat-ing a note costs no
 * network at all. Content is a separate, explicit request.
 */
export interface VaultTreeView {
  /** Immediate children of a vault-relative dir ('' = root), or null if it is not a known folder. */
  children(relDir: string): { name: string; entry: VaultEntry }[] | null;
  /** Info for a vault-relative path, or null when the model has never heard of it. */
  entry(rel: string): VaultEntry | null;
}

export interface FsModulePatcherDeps {
  /** The shared `require('fs')` object — the very one plugins get. */
  fsModule: Record<string, unknown>;
  /** Absolute shadow-vault root. Only paths under it are virtualised. */
  root: string;
  /** Vault-relative config dir; it is real on disk and must stay untouched. */
  configDir: string;
  tree: VaultTreeView;
  /**
   * Put one file on the disk, synchronously. True when it is there
   * afterwards. Bounded by the cache budget — a refusal just means the
   * caller gets the real filesystem's answer.
   */
  materialize(rel: string): boolean;
}

/** The functions we take over. Everything else stays stock. */
const PATCHED = ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync'] as const;

/**
 * Makes the remote vault visible to plugins that use Node's `fs`
 * directly instead of the vault API — the read half of #429.
 *
 * ## What it does, and what it deliberately does not
 *
 * The vault is not cloned, so the shadow disk holds almost nothing.
 * This patch supplies the missing answers from the two sources that
 * already exist:
 *
 *  - **names and stats** come from `vault.fileMap`, which the
 *    background indexer already fills with the whole remote tree. So
 *    `readdirSync(basePath)` lists the vault and `statSync` reports a
 *    real size — with **no download at all**.
 *  - **content** comes from `materialize`, and only when somebody
 *    actually calls `readFileSync`. That call IS the request. A file
 *    over the cache budget is not fetched, and the caller then gets the
 *    same ENOENT it would have got before.
 *
 * Writes are NOT patched: they already land on the real disk, where
 * `LocalWriteWatcher` picks them up and pushes them to the remote.
 *
 * ## Scope discipline
 *
 * `fs` is shared with Obsidian itself and every other plugin, so the
 * patch answers ONLY for paths that (a) resolve under the shadow root,
 * (b) are outside the config dir — which is real on disk and owned by
 * the config write-through — and (c) do not already exist on disk. In
 * every other case the original function runs, untouched, first.
 *
 * ## The limit worth knowing
 *
 * A plugin that destructures before we patch —
 * `const { readFileSync } = require('fs')` at module scope — captured
 * the original and never sees this. Nothing can fix that from here.
 */
export class FsModulePatcher {
  private readonly originals = new Map<string, unknown>();
  private patched = false;

  constructor(private readonly deps: FsModulePatcherDeps) {}

  isPatched(): boolean {
    return this.patched;
  }

  patch(): boolean {
    if (this.patched) return true;
    const mod = this.deps.fsModule;
    for (const name of PATCHED) {
      if (typeof mod[name] !== 'function') {
        logger.warn(`FsModulePatcher: fs.${name} is not a function — not patching anything`);
        return false;
      }
    }
    try {
      for (const name of PATCHED) this.originals.set(name, mod[name]);
      mod.readFileSync = this.makeReadFileSync();
      mod.readdirSync = this.makeReaddirSync();
      mod.existsSync = this.makeExistsSync();
      mod.statSync = this.makeStatSync('statSync');
      mod.lstatSync = this.makeStatSync('lstatSync');
      this.patched = true;
      logger.info(`FsModulePatcher: patched fs.[${PATCHED.join(', ')}] for the shadow vault root`);
      return true;
    } catch (e) {
      logger.error(`FsModulePatcher: patch failed (${errorMessage(e)}); restoring`);
      this.restore();
      return false;
    }
  }

  restore(): void {
    const mod = this.deps.fsModule;
    for (const [name, fn] of this.originals) {
      try { mod[name] = fn; } catch { /* best effort */ }
    }
    this.originals.clear();
    this.patched = false;
  }

  /**
   * Vault-relative path for something under the shadow root, or null
   * when the path is none of our business. Resolves first, so `..`
   * cannot walk out of the root and back in through a lie.
   */
  private toVaultRel(target: unknown): string | null {
    if (typeof target !== 'string' || target === '') return null;
    let abs: string;
    try {
      abs = nodePath.resolve(target);
    } catch {
      return null;
    }
    const root = nodePath.resolve(this.deps.root);
    if (abs !== root && !abs.startsWith(root + nodePath.sep)) return null;
    const rel = abs === root ? '' : abs.slice(root.length + 1).split(nodePath.sep).join('/');
    if (rel.split('/')[0] === this.deps.configDir) return null;   // real on disk; not ours
    return rel;
  }

  private orig<T>(name: string): T {
    return this.originals.get(name) as T;
  }

  private makeReadFileSync() {
    const original = this.orig<(...a: unknown[]) => unknown>('readFileSync');
    return (target: unknown, ...rest: unknown[]): unknown => {
      const rel = this.toVaultRel(target);
      if (rel !== null && rel !== '' && !this.existsOnDisk(target)) {
        // The request that materialises. If it is refused (over budget,
        // no bridge, unknown path) the original throws ENOENT below,
        // which is exactly what the caller would have got before.
        try {
          this.deps.materialize(rel);
        } catch (e) {
          logger.info(`FsModulePatcher: materialise "${rel}" failed (${errorMessage(e)})`);
        }
      }
      return original(target, ...rest);
    };
  }

  private makeReaddirSync() {
    const original = this.orig<(...a: unknown[]) => unknown>('readdirSync');
    return (target: unknown, ...rest: unknown[]): unknown => {
      const rel = this.toVaultRel(target);
      if (rel === null) return original(target, ...rest);
      const modelChildren = this.deps.tree.children(rel);
      if (!modelChildren) return original(target, ...rest);

      let real: unknown[] = [];
      try {
        real = original(target, ...rest) as unknown[];
      } catch {
        real = [];                     // virtual-only directory: the model is the answer
      }
      const withFileTypes = Boolean(
        rest[0] && typeof rest[0] === 'object'
        && (rest[0] as { withFileTypes?: boolean }).withFileTypes,
      );
      const seen = new Set(
        real.map(e => (typeof e === 'string' ? e : String((e as { name?: string }).name ?? ''))),
      );
      const extra = modelChildren
        .filter(c => !seen.has(c.name))
        .map(c => (withFileTypes ? makeDirent(c.name, c.entry.isDir) : c.name));
      return [...real, ...extra];
    };
  }

  private makeExistsSync() {
    const original = this.orig<(p: unknown) => boolean>('existsSync');
    return (target: unknown): boolean => {
      if (original(target)) return true;
      const rel = this.toVaultRel(target);
      if (rel === null) return false;
      if (rel === '') return true;
      return this.deps.tree.entry(rel) !== null;
    };
  }

  private makeStatSync(name: 'statSync' | 'lstatSync') {
    const original = this.orig<(...a: unknown[]) => unknown>(name);
    return (target: unknown, ...rest: unknown[]): unknown => {
      if (this.existsOnDisk(target)) return original(target, ...rest);
      const rel = this.toVaultRel(target);
      if (rel === null || rel === '') return original(target, ...rest);
      const entry = this.deps.tree.entry(rel);
      if (!entry) return original(target, ...rest);   // let the real ENOENT happen
      return makeStats(entry);
    };
  }

  private existsOnDisk(target: unknown): boolean {
    try {
      return this.orig<(p: unknown) => boolean>('existsSync')(target);
    } catch {
      return false;
    }
  }
}

/**
 * `Dirent`-shaped record for a path that exists in the vault but not on
 * disk. Only the predicates consumers actually call are implemented;
 * everything the real `Dirent` would report about links or devices is
 * false, which is true of a remote vault entry.
 */
function makeDirent(name: string, isDir: boolean): Record<string, unknown> {
  return {
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

/** `Stats`-shaped record built from the vault model. Sizes and mtimes are real. */
function makeStats(entry: VaultEntry): Record<string, unknown> {
  const when = new Date(entry.mtimeMs);
  const size = entry.isDir ? 0 : entry.size;
  return {
    size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.mtimeMs,
    atimeMs: entry.mtimeMs,
    birthtimeMs: entry.mtimeMs,
    mtime: when,
    ctime: when,
    atime: when,
    birthtime: when,
    mode: entry.isDir ? 0o040755 : 0o100644,
    nlink: 1,
    uid: 0,
    gid: 0,
    dev: 0,
    ino: 0,
    rdev: 0,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    isFile: () => !entry.isDir,
    isDirectory: () => entry.isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}
