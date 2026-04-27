import type { TAbstractFile, TFile, TFolder, Vault } from 'obsidian';
import { logger } from '../util/logger';

/**
 * One entry the builder needs in order to materialise a TFile or
 * TFolder in the vault model. Caller (typically the auto-connect flow
 * in the shadow window) is responsible for collecting these by walking
 * the patched adapter.
 */
export interface RemoteEntry {
  /** Vault-relative POSIX path, no leading slash. Must NOT be empty. */
  path: string;
  isDirectory: boolean;
  /**
   * stat fields the file editor / Obsidian's own internals expect.
   * For folders these are ignored; pass zeroes if unknown.
   */
  ctime: number;
  mtime: number;
  size: number;
}

export interface BuildResult {
  filesAdded: number;
  foldersAdded: number;
  /** Entries whose path was already in vault.fileMap. */
  skipped: number;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Constructors for `TFile` and `TFolder`. Injected because the
 * `obsidian` package ships only `.d.ts` — at test time we have no
 * runtime to `new TFile()` against, so we pass stubs; at plugin runtime
 * we pass the real constructors imported from `obsidian`.
 *
 * **Both constructors must take `(vault, path)`.** Discovered via
 * devtools 2026-04-27: `new TFolder()` with no args throws
 * `Cannot read properties of undefined (reading 'lastIndexOf')` from
 * inside Obsidian — the constructor calls `path.lastIndexOf('/')` to
 * derive `name`. `new TFile()` (no args) appeared to work in the
 * earlier OQ2 test only because we never read the auto-derived
 * fields; passing `(vault, path)` is the only safe form for both.
 */
export interface ObsidianClassDeps {
  TFile:   new (vault: Vault, path: string) => TFile;
  TFolder: new (vault: Vault, path: string) => TFolder;
}

/**
 * Build (or extend) the in-memory vault file tree from a list of
 * remote entries. Used by the shadow-vault flow once the RPC session
 * is up and the patched adapter is in place.
 *
 * The builder never writes to disk — it only constructs `TFile` /
 * `TFolder` objects and inserts them into `vault.fileMap` and the
 * appropriate parent's `children` array, then fires
 * `vault.trigger('create', file)` so File Explorer and metadata cache
 * pick the entries up.
 *
 * Folders are inserted before any files contained in them. Within
 * one call, parent folders for a given file must either already
 * exist in the vault or appear earlier in the entry list.
 */
export class VaultModelBuilder {
  constructor(
    private readonly vault: Vault,
    private readonly deps: ObsidianClassDeps,
  ) {}

  async build(entries: ReadonlyArray<RemoteEntry>): Promise<BuildResult> {
    const result: BuildResult = {
      filesAdded: 0, foldersAdded: 0, skipped: 0, errors: [],
    };

    // Folders before files at the same depth, then by depth ascending,
    // so parents always exist by the time their children are processed.
    const ordered = [...entries].sort(byFoldersFirstThenDepth);

    for (const entry of ordered) {
      if (!entry.path) {
        result.errors.push({ path: entry.path, message: 'empty path is not allowed' });
        continue;
      }
      if (this.vault.getAbstractFileByPath(entry.path)) {
        result.skipped++;
        continue;
      }
      const parent = this.resolveParent(entry.path);
      if (!parent) {
        result.errors.push({
          path: entry.path,
          message: `parent folder for "${entry.path}" not found in vault`,
        });
        continue;
      }
      try {
        if (entry.isDirectory) {
          this.insertFolder(entry.path, parent);
          result.foldersAdded++;
        } else {
          this.insertFile(entry, parent);
          result.filesAdded++;
        }
      } catch (e) {
        result.errors.push({ path: entry.path, message: (e as Error).message });
      }
    }

    logger.info(
      `VaultModelBuilder: built ${result.filesAdded}f + ${result.foldersAdded}d, ` +
      `${result.skipped} skipped, ${result.errors.length} errors`,
    );
    return result;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private resolveParent(path: string): TFolder | null {
    const i = path.lastIndexOf('/');
    if (i < 0) return this.vault.getRoot();
    const parentPath = path.slice(0, i);
    const parent = this.vault.getAbstractFileByPath(parentPath);
    if (!parent) return null;
    if (!isFolder(parent)) return null;
    return parent;
  }

  private insertFile(entry: RemoteEntry, parent: TFolder): void {
    // Pass (vault, path) to satisfy Obsidian's TFile constructor —
    // see the doc comment on `ObsidianClassDeps` for why.
    const file = new this.deps.TFile(this.vault, entry.path);
    const name = basename(entry.path);
    const dot = name.lastIndexOf('.');
    // Override after construction in case the constructor's defaults
    // for these fields don't match what we want (parent in particular —
    // Obsidian may default it to null, we always want the real folder).
    file.vault     = this.vault;
    file.path      = entry.path;
    file.name      = name;
    file.basename  = dot > 0 ? name.slice(0, dot) : name;
    file.extension = dot > 0 ? name.slice(dot + 1) : '';
    file.parent    = parent;
    file.stat      = { ctime: entry.ctime, mtime: entry.mtime, size: entry.size };

    insertIntoFileMap(this.vault, entry.path, file);
    parent.children.push(file);
    this.vault.trigger('create', file);
  }

  private insertFolder(path: string, parent: TFolder): void {
    const folder = new this.deps.TFolder(this.vault, path);
    folder.vault    = this.vault;
    folder.path     = path;
    folder.name     = basename(path);
    folder.parent   = parent;
    // Constructor may have given us a children array already; reset
    // to a known-empty state so callers don't see stale entries.
    folder.children = [];

    insertIntoFileMap(this.vault, path, folder);
    parent.children.push(folder);
    // Folders intentionally do not trigger 'create' — File Explorer
    // discovers them via the children array, and other consumers
    // (Templater, Dataview) only care about files.
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Sort key: folders first at any given depth, then by depth ascending.
 * Two folders at the same depth, or two files at the same depth, are
 * ordered lexicographically for deterministic output.
 */
function byFoldersFirstThenDepth(a: RemoteEntry, b: RemoteEntry): number {
  const da = depthOf(a.path);
  const db = depthOf(b.path);
  if (da !== db) return da - db;
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function depthOf(path: string): number {
  let count = 0;
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '/') count++;
  }
  return count;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function isFolder(file: TAbstractFile): file is TFolder {
  return Array.isArray((file as TFolder).children);
}

/**
 * Vault.fileMap is a documented internal field on FileSystemAdapter-
 * backed vaults. It's typed as a private property in @types/obsidian,
 * so we cast through `unknown` to a record of TAbstractFile.
 */
function insertIntoFileMap(vault: Vault, path: string, entry: TAbstractFile): void {
  const map = (vault as unknown as { fileMap: Record<string, TAbstractFile> }).fileMap;
  map[path] = entry;
}
