import type { TAbstractFile, TFile, TFolder, Vault } from 'obsidian';
import type { WriterReflector } from '../adapter/WriterReflector';
import { logger } from '../util/logger';
import { perfTracer } from '../util/PerfTracer';
import { errorMessage } from "../util/errorMessage";

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
 * Per-call options for `insertOne`.
 *
 * `ensureParents`: when true and the entry's parent folder is missing,
 * recursively synthesise the missing folder ancestors instead of
 * failing. Use from live-update paths (#107) where fs.changed events
 * can arrive out of order; leave off for bulk `build()` so a
 * malformed walk is still caught as an error.
 */
export interface InsertOneOptions {
  ensureParents?: boolean;
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

  build(entries: ReadonlyArray<RemoteEntry>): Promise<BuildResult> {
    return Promise.resolve(this.buildSync(entries));
  }

  /**
   * Synchronous body of `build`. Returns a `BuildResult` directly so the
   * public `build` keeps its `Promise<BuildResult>` shape (callers
   * already `await` it) without an `async` keyword that
   * `@typescript-eslint/require-await` would flag — every step here
   * is in-memory: no I/O actually awaits.
   */
  private buildSync(entries: ReadonlyArray<RemoteEntry>): BuildResult {
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
        result.errors.push({ path: entry.path, message: errorMessage(e) });
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

  // ─── single-entry mutations (Phase 6A: live updates) ───────────────────

  /**
   * Insert one entry into the vault model and fire `vault.trigger('create')`.
   *
   * - Returns the inserted `TFile` / `TFolder` on success.
   * - Returns `null` if the path was already registered (idempotent).
   * - Returns `null` and warns if the entry's parent folder is missing
   *   from the vault (the caller should typically insert parents
   *   first; for `fs.watch`-driven creates the watcher fires for
   *   parent before children, so this is rare).
   *
   * Used by both the bulk `build()` path and the `fs.watch` live-update
   * handler — same insertion semantics regardless of source.
   */
  insertOne(entry: RemoteEntry, opts?: InsertOneOptions): TFile | TFolder | null {
    if (!entry.path) return null;
    if (this.vault.getAbstractFileByPath(entry.path)) return null;
    let parent = this.resolveParent(entry.path);
    if (!parent && opts?.ensureParents) {
      // Race-window self-heal (#107): the daemon's catch-up walk for a
      // nested mkdir may push child events ahead of their ancestors,
      // and applyChange's async stat fan-out can reorder them further.
      // Walk up and synthesise the missing folder ancestors so a leaf
      // is never silently lost. Opt-in so the bulk `build()` path
      // (which sorts parents-first and treats "parent missing" as a
      // malformed-walk error) keeps its sanity check.
      parent = this.ensureParentFolder(entry.path);
    }
    if (!parent) {
      logger.warn(`VaultModelBuilder.insertOne: parent missing for "${entry.path}"`);
      return null;
    }
    return entry.isDirectory
      ? this.insertFolder(entry.path, parent)
      : this.insertFile(entry, parent);
  }

  /**
   * Idempotently materialise the chain of folder ancestors for
   * `childPath`. Recursively walks up from `childPath`'s parent,
   * stopping at the vault root (which always exists). Returns the
   * direct parent TFolder, or null if even the root can't be found
   * (catastrophic — shouldn't happen in any real Obsidian session).
   */
  private ensureParentFolder(childPath: string): TFolder | null {
    const i = childPath.lastIndexOf('/');
    if (i < 0) {
      // Top-level path; resolveParent should have returned the
      // root folder. If it didn't, there's nothing we can do here.
      return this.resolveParent(childPath);
    }
    const parentPath = childPath.slice(0, i);
    const existing = this.vault.getAbstractFileByPath(parentPath);
    if (existing && isFolder(existing)) return existing;
    // Recursively insert the parent folder. insertOne re-enters this
    // helper for grandparents until we reach a path that's already
    // in the model (typically the vault root). Inserted entry is a
    // directory (we passed `isDirectory: true`), so the result is
    // either a TFolder or null; narrow via the isFolder duck-type.
    const inserted = this.insertOne(
      { path: parentPath, isDirectory: true, ctime: 0, mtime: 0, size: 0 },
      { ensureParents: true },
    );
    if (inserted && isFolder(inserted)) return inserted;
    return null;
  }

  /**
   * Remove one path from the vault model and fire `vault.trigger('delete')`.
   *
   * - Removes from both `vault.fileMap` and the parent folder's
   *   `children` array.
   * - For folders, also recursively removes descendants from
   *   `vault.fileMap` (their parent's `children` array is already
   *   gone, so they become unreachable).
   * - Returns `true` if removed, `false` if the path wasn't in the model.
   */
  removeOne(path: string): boolean {
    if (!path) return false;
    const target = this.vault.getAbstractFileByPath(path);
    if (!target) return false;

    // Pull out of parent.children if any.
    const parent = target.parent;
    if (parent && Array.isArray(parent.children)) {
      const idx = parent.children.indexOf(target);
      if (idx >= 0) parent.children.splice(idx, 1);
    }

    const map = (this.vault as unknown as { fileMap: Record<string, TAbstractFile> }).fileMap;

    // Folders: also drop every descendant from fileMap so we don't
    // leak orphan TFile entries that File Explorer will keep in its
    // own model.
    if (isFolder(target)) {
      const prefix = target.path + '/';
      for (const key of Object.keys(map)) {
        if (key.startsWith(prefix)) delete map[key];
      }
    }
    delete map[path];

    perfTracer.point('T5a', perfTracer.newCid(), { op: 'delete', path });
    this.vault.trigger('delete', target);
    return true;
  }

  /**
   * Update an existing file's stat and fire `vault.trigger('modify')`.
   *
   * Folder paths are silently ignored — Obsidian doesn't fire
   * `modify` for folders, and file-explorer / metadata-cache plugins
   * don't expect to see one.
   *
   * Returns `true` if the file existed (and was updated), `false`
   * otherwise.
   */
  modifyOne(path: string, stat?: { ctime: number; mtime: number; size: number }): boolean {
    const target = this.vault.getAbstractFileByPath(path);
    if (!target) return false;
    if (isFolder(target)) return false;
    // Narrow via `instanceof this.deps.TFile`. Tests inject FakeTFile as
    // `deps.TFile`, and every entry inserted into the model is built via
    // `new this.deps.TFile(...)` (see `insertFile`), so this works
    // identically inside Obsidian and in unit tests. The compiler still
    // sees `target` as `TAbstractFile`, so we narrow with the structural
    // overload pattern.
    if (!(target instanceof this.deps.TFile)) return false;
    const file: TFile = target;
    if (stat) {
      file.stat = stat;
    }
    perfTracer.point('T5a', perfTracer.newCid(), { op: 'modify', path });
    this.vault.trigger('modify', file);
    return true;
  }

  /**
   * Move/rename one path in the vault model and fire
   * `vault.trigger('rename', file, oldPath)`.
   *
   * Updates `path`, `name`, and (for files) `basename`/`extension`
   * fields, moves the entry between `vault.fileMap` keys, and shifts
   * it between parent.children arrays if the parent changed.
   *
   * For folders, recursively rewrites descendant paths so they keep
   * pointing at the new parent.
   *
   * Returns `true` if the rename happened, `false` if the source
   * wasn't in the model or the destination's parent is missing.
   */
  renameOne(oldPath: string, newPath: string): boolean {
    if (!oldPath || !newPath || oldPath === newPath) return false;
    const target = this.vault.getAbstractFileByPath(oldPath);
    if (!target) return false;
    const newParent = this.resolveParent(newPath);
    if (!newParent) {
      logger.warn(`VaultModelBuilder.renameOne: parent missing for "${newPath}"`);
      return false;
    }

    const map = (this.vault as unknown as { fileMap: Record<string, TAbstractFile> }).fileMap;
    const oldParent = target.parent;

    // Detach from old parent's children.
    if (oldParent && Array.isArray(oldParent.children)) {
      const idx = oldParent.children.indexOf(target);
      if (idx >= 0) oldParent.children.splice(idx, 1);
    }

    // Update path-derived fields on the entry itself.
    const newName = basename(newPath);
    const oldPaths: Array<{ entry: TAbstractFile; oldKey: string; newKey: string }> = [
      { entry: target, oldKey: oldPath, newKey: newPath },
    ];
    target.path   = newPath;
    target.name   = newName;
    target.parent = newParent;
    if (!isFolder(target)) {
      // Narrow via `instanceof this.deps.TFile` (same pattern as
      // `modifyOne`). Tests inject FakeTFile, and every file in the
      // model was constructed via `new this.deps.TFile(...)`, so the
      // check holds in both contexts.
      if (target instanceof this.deps.TFile) {
        const file: TFile = target;
        const dot = newName.lastIndexOf('.');
        file.basename  = dot > 0 ? newName.slice(0, dot) : newName;
        file.extension = dot > 0 ? newName.slice(dot + 1) : '';
      }
    } else {
      // For a folder, also rewrite every descendant's path so
      // fileMap keys + entry.path stay in sync. Collect first, then
      // mutate, so the iteration doesn't re-scan our own changes.
      const prefix = oldPath + '/';
      for (const key of Object.keys(map)) {
        if (!key.startsWith(prefix)) continue;
        const desc = map[key];
        const newKey = newPath + '/' + key.slice(prefix.length);
        oldPaths.push({ entry: desc, oldKey: key, newKey });
        desc.path = newKey;
      }
    }

    // Apply fileMap key moves (delete olds, then set news, so a
    // self-overlap can't lose entries).
    for (const m of oldPaths) delete map[m.oldKey];
    for (const m of oldPaths) map[m.newKey] = m.entry;

    // Attach to new parent's children.
    newParent.children.push(target);

    perfTracer.point('T5a', perfTracer.newCid(), { op: 'rename', path: oldPath, newPath });
    this.vault.trigger('rename', target, oldPath);
    return true;
  }

  // ─── writer self-reflect (#341) ─────────────────────────────────────────
  //
  // These four methods structurally satisfy `adapter/WriterReflector`.
  // `SftpDataAdapter` calls them after a local-originated mutation so
  // the writer's own vault model stays in sync without waiting for a
  // remote `FsChangeListener` echo (which never arrives on the SFTP
  // transport — no daemon). There is no `implements WriterReflector`
  // clause: that would force a runtime `vault → adapter` import for a
  // value the class never references. Conformance is instead pinned
  // at build time by the type-only `satisfies`-style anchor at the
  // bottom of this file (tsconfig compiles only `src/**`, so the test
  // wiring is *not* a typecheck — without the anchor a `reflect*`
  // signature drift would ship green).
  //
  // The underlying `*One` mutators return `false` when the model
  // couldn't be updated (path not modelled, destination parent
  // missing). For a writer reflect that `false` means the writer's
  // own vault model just diverged from the remote — the exact #341
  // symptom — so it is logged rather than silently dropped.

  /**
   * Reflect a writer-side `adapter.write` / `writeBinary`. Inserts the
   * file (firing `create`) when the path is new, otherwise bumps it
   * (firing `modify`). Missing parent folders are synthesised so a
   * write into a not-yet-modelled subtree still lands.
   */
  reflectWrite(path: string): void {
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing) {
      if (isFolder(existing)) {
        // A folder occupies the path the adapter just wrote a file
        // to (a folder→file swap raced our model). Firing `modify`
        // for a TFolder would mislead File Explorer; not firing
        // leaves the model wrong. Neither is recoverable here — log
        // so the divergence is diagnosable.
        logger.warn(
          `VaultModelBuilder.reflectWrite: "${path}" is modelled as a folder; ` +
          'model diverged from remote (file written over a folder)',
        );
        return;
      }
      if (!this.modifyOne(path)) {
        logger.warn(
          `VaultModelBuilder.reflectWrite: modifyOne("${path}") no-op; ` +
          'writer model may be stale for this path',
        );
      }
      return;
    }
    if (!this.insertOne(
      { path, isDirectory: false, ctime: 0, mtime: Date.now(), size: 0 },
      { ensureParents: true },
    )) {
      // insertOne returns null when even ensureParents couldn't
      // synthesise the chain (catastrophic — root missing). The new
      // file exists on the remote but not in the writer's model:
      // File Explorer won't show it until the next full populate.
      logger.warn(
        `VaultModelBuilder.reflectWrite: insertOne("${path}") no-op; ` +
        'new file not reflected into the writer model',
      );
    }
  }

  /** Reflect a writer-side `adapter.rename`. */
  reflectRename(oldPath: string, newPath: string): void {
    if (!this.renameOne(oldPath, newPath)) {
      // The open editor tab stays bound to the stale TFile — this is
      // the core #341 failure. renameOne already warns with the
      // specific cause; add the reflect context.
      logger.warn(
        `VaultModelBuilder.reflectRename: "${oldPath}" → "${newPath}" not reflected; ` +
        'writer vault model is stale (editor may still point at the old path)',
      );
    }
  }

  /**
   * Reflect a writer-side `adapter.remove` / `rmdir`. A `false` from
   * `removeOne` (path was never modelled) is benign for a delete —
   * the desired end state (absent) already holds — so it is not
   * logged.
   */
  reflectRemove(path: string): void {
    this.removeOne(path);
  }

  /** Reflect a writer-side `adapter.mkdir` (idempotent if modelled). */
  reflectMkdir(path: string): void {
    if (this.vault.getAbstractFileByPath(path)) return;
    if (!this.insertOne(
      { path, isDirectory: true, ctime: 0, mtime: Date.now(), size: 0 },
      { ensureParents: true },
    )) {
      logger.warn(
        `VaultModelBuilder.reflectMkdir: insertOne("${path}") no-op; ` +
        'new folder not reflected into the writer model',
      );
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private insertFile(entry: RemoteEntry, parent: TFolder): TFile {
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
    perfTracer.point('T5a', perfTracer.newCid(), { op: 'create', path: entry.path });
    this.vault.trigger('create', file);
    return file;
  }

  private insertFolder(path: string, parent: TFolder): TFolder {
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
    perfTracer.point('T5a', perfTracer.newCid(), { op: 'create', path });
    // Fire `create` for folders too. The original Phase 1 design
    // assumed File Explorer would discover folders via parent's
    // children array, but Phase 4 smoke proved that wrong: File
    // Explorer's `view.onCreate` is the only path that registers a
    // folder in `view.fileItems`, and without that the folder DOM
    // never gets built — so files inside also stay hidden even when
    // they're correctly in `vault.fileMap`. Folders being processed
    // before their files (per `byFoldersFirstThenDepth`) means each
    // file's `create` event finds its parent already registered.
    this.vault.trigger('create', folder);
    return folder;
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
  // Duck-typing on `.children` rather than `instanceof TFolder`: this helper
  // also runs against the FakeTFile/FakeTFolder stubs the unit suite uses, so
  // an `instanceof` check would produce false negatives outside Obsidian.
  // We cast through an anonymous structural type (not `TFolder`) so the
  // `obsidianmd/no-tfile-tfolder-cast` rule doesn't fire.
  return Array.isArray((file as { children?: unknown[] }).children);
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

// Build-time proof that VaultModelBuilder structurally satisfies
// WriterReflector. `tsconfig.json` compiles only `src/**`, so the
// test wiring (`adapter.setWriterReflector(builder)`) is never
// typechecked — without this anchor a `reflect*` rename or signature
// drift would ship green and silently no-op behind the adapter's
// optional chaining. Type-only: zero runtime, no `vault → adapter`
// import edge. `Exact extends true` forces a compile error the moment
// conformance breaks.
type _Assert<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time conformance check, intentionally unused at runtime
type _WriterReflectorConformance = _Assert<
  VaultModelBuilder extends WriterReflector ? true : false
>;
