import * as fs from 'fs';
import * as path from 'path';
import { nativeFs } from './nativeFs';
import { logger } from './logger';
import { errorMessage } from './errorMessage';

/** Handle returned by {@link watchTree}. `close()` is idempotent. */
export interface TreeWatcher {
  close(): void;
}

/**
 * Filesystem surface {@link watchTree} needs, injected so the
 * platform-fallback logic is unit-testable without real watchers.
 */
export interface WatchTreeDeps {
  /**
   * Watch one directory. `recursive` asks the platform for a subtree
   * watch; implementations MUST throw when they cannot honour it, so
   * `watchTree` can fall back instead of silently watching one level.
   * The callback receives the path the platform reports (relative to
   * `dir`), or `null` when it reports an event without a filename.
   */
  watch(dir: string, recursive: boolean, onEvent: (filename: string | null) => void): { close(): void };
  /** Immediate child directory names of `dir`. Empty on any error. */
  listDirs(dir: string): string[];
}

/**
 * Upper bound on directories watched in the fallback path. A shadow
 * vault's local disk holds only the config tree plus whatever a plugin
 * wrote there, so this is far above any realistic tree — but a user
 * who points a profile at a huge directory would otherwise exhaust the
 * process's inotify budget. Hitting it is logged, never silent.
 */
const MAX_WATCHED_DIRS = 2048;

const nodeDeps: WatchTreeDeps = {
  watch: (dir, recursive, onEvent) => {
    const w = fs.watch(
      dir,
      { persistent: false, recursive },
      (_evt, filename) => onEvent(filename === null || filename === undefined ? null : String(filename)),
    );
    return { close: () => w.close() };
  },
  listDirs: (dir) => {
    try {
      return nativeFs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }
  },
};

/**
 * Watch `root` and everything under it, reporting each change as a
 * path RELATIVE to `root` with `/` separators (or `null` when the
 * platform gave no filename — the caller must then re-scan).
 *
 * `fs.watch(..., { recursive: true })` is native on Windows and macOS
 * and on Linux only from Node 20.13; Electron builds below that throw
 * `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. Rather than degrade to a
 * root-only watch (which would see a plugin's write into a subfolder
 * as nothing at all), we fall back to watching every directory
 * individually and adopting new ones as they appear.
 *
 * `prune` keeps the fallback off trees we would never act on anyway
 * (the config dir, `.git`, `node_modules`); it takes a root-relative
 * directory path.
 */
export function watchTree(
  root: string,
  onChange: (rel: string | null) => void,
  prune: (relDir: string) => boolean = () => false,
  deps: WatchTreeDeps = nodeDeps,
): TreeWatcher {
  try {
    const w = deps.watch(root, true, (filename) => {
      onChange(filename === null ? null : toPosix(filename));
    });
    return { close: () => { try { w.close(); } catch { /* best effort */ } } };
  } catch (e) {
    logger.info(
      `watchTree: recursive watch unavailable (${errorMessage(e)}); ` +
      'falling back to per-directory watchers',
    );
  }

  const watchers = new Map<string, { close(): void }>();
  let closed = false;

  const add = (relDir: string): void => {
    if (closed || watchers.has(relDir)) return;
    if (relDir !== '' && prune(relDir)) return;
    if (watchers.size >= MAX_WATCHED_DIRS) {
      logger.warn(
        `watchTree: watcher budget (${MAX_WATCHED_DIRS} dirs) exhausted — ` +
        `"${relDir}" and any deeper directory are NOT watched`,
      );
      return;
    }
    const abs = relDir === '' ? root : path.join(root, relDir);
    let w: { close(): void };
    try {
      w = deps.watch(abs, false, (filename) => {
        if (filename === null) {
          onChange(null);
          return;
        }
        const rel = relDir === '' ? toPosix(filename) : `${relDir}/${toPosix(filename)}`;
        // A newly created directory needs its own watcher, and the
        // files a plugin drops into it may already exist by the time
        // we get here — so adopt it (which recurses) before reporting.
        adopt(rel);
        onChange(rel);
      });
    } catch (err) {
      // Racing removal, or a permission we don't have. Not fatal: the
      // parent's watcher still reports changes to the directory entry.
      logger.info(`watchTree: cannot watch "${abs}" (${errorMessage(err)})`);
      return;
    }
    watchers.set(relDir, w);
    for (const child of deps.listDirs(abs)) {
      add(relDir === '' ? child : `${relDir}/${child}`);
    }
  };

  /** Adopt `rel` if it turned out to be a directory (cheap no-op otherwise). */
  const adopt = (rel: string): void => {
    const abs = path.join(root, rel);
    if (deps.listDirs(path.dirname(abs)).includes(path.basename(abs))) add(rel);
  };

  add('');

  return {
    close: () => {
      closed = true;
      for (const w of watchers.values()) {
        try { w.close(); } catch { /* best effort */ }
      }
      watchers.clear();
    },
  };
}

/**
 * Cap on {@link listTreeFiles}. The local root of a shadow vault holds
 * the config tree plus whatever an out-of-band writer left there, so
 * this is unreachable in practice; a scan that hits it is truncated
 * LOUDLY rather than silently returning a partial tree.
 */
const MAX_SCAN_FILES = 20_000;

/**
 * Every regular file under `root`, as root-relative posix paths.
 * `prune` is consulted with the root-relative path of each directory
 * and file, so callers pass the same predicate they watch with.
 *
 * Used when the platform reports a change without a filename: the only
 * way to find out what moved is to look.
 */
export function listTreeFiles(
  root: string,
  prune: (rel: string) => boolean = () => false,
): string[] {
  const found: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = nativeFs.readdirSync(relDir === '' ? root : path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;                       // vanished or unreadable — nothing to report
    }
    for (const e of entries) {
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
      if (prune(rel)) continue;
      if (e.isDirectory()) {
        stack.push(rel);
      } else if (e.isFile()) {
        if (found.length >= MAX_SCAN_FILES) {
          logger.warn(
            `listTreeFiles: stopped at ${MAX_SCAN_FILES} files under "${root}" — ` +
            'the rest of the tree was NOT scanned',
          );
          return found;
        }
        found.push(rel);
      }
    }
  }
  return found;
}

const toPosix = (p: string): string => p.split(path.sep).join('/').replace(/\\/g, '/');
