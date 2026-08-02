import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/** The bits of a local `stat` this watcher reasons about. */
export interface LocalFileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Injectable surface so the debounce / stability / ledger logic is
 * unit-testable without a real filesystem, timers or an SSH session.
 * All paths are vault-relative with `/` separators.
 */
export interface LocalWriteWatcherDeps {
  /**
   * Start watching the shadow vault's local root. `onChange` gets the
   * changed path, or `null` when the platform reported an event with
   * no filename (the watcher then re-scans).
   */
  watch(onChange: (rel: string | null) => void): { close(): void };
  /** Every regular file currently under the watched root. Used for the `null` event. */
  scan(): string[];
  /** `null` when the path is absent, unreadable, or not a regular file. */
  stat(rel: string): LocalFileStat | null;
  /** Bytes of the local file; `null` if it vanished or cannot be read. */
  read(rel: string): Buffer | null;
  /** Push local bytes to the remote vault (through the patched adapter). */
  push(rel: string, data: Buffer): Promise<void>;
  /** Delete the remote counterpart of a path we previously pushed. */
  removeRemote(rel: string): Promise<void>;
  /** True for paths the write-back must never touch (config tree, VCS, temp files). */
  ignore(rel: string): boolean;
  /**
   * True when the bytes on disk are a copy the plugin itself
   * materialised from the remote (`MaterializedCache`), so pushing them
   * back would be an echo of the remote's own content. Defaults to
   * never — a deployment without the disk cache is unaffected.
   */
  isMirroredCopy?(rel: string, stat: LocalFileStat): boolean;
  /** Largest single file to push. Bigger files are skipped, loudly. */
  maxBytes: number;
  /** Coalesces a burst of writes; also the interval between stability samples. */
  debounceMs: number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Surfaced to the user (a Notice). Called once per failing path. */
  onError?(rel: string, message: string): void;
}

/**
 * Filename patterns that are never vault content: OS junk, editor
 * swap/backup files, and the plugin's own atomic-write temp suffix.
 * Pushing one would litter the remote with garbage that a later local
 * cleanup then deletes again.
 */
const TEMP_FILE = /(^\.DS_Store$)|(^Thumbs\.db$)|(^desktop\.ini$)|(^\.~lock\.)|(^\.#)|(~$)|(\.sw[a-p]$)|(\.tmp$)|(\.rsh_tmp$)|(\.crswap$)/i;

/**
 * Build the "never write this back" predicate for a vault-relative path.
 *
 * `configDir` is excluded because `SftpDataAdapter.writeThroughConfig`
 * already owns that tree in the other direction — the local copy there
 * is a cache the plugin itself writes, so pushing it back would echo
 * our own bytes, and `SharedConfigWatcher` handles the files that DO
 * need to travel. `ignoreDirs` is the same list the remote walk prunes
 * (`DEFAULT_WALK_IGNORE_DIRS`): a directory we refuse to read from the
 * remote must not be pushed to it either.
 */
export function makeLocalWriteIgnore(
  configDir: string,
  ignoreDirs: readonly string[],
): (rel: string) => boolean {
  const pruned = new Set<string>([configDir, '.trash', ...ignoreDirs]);
  return (rel: string): boolean => {
    const segments = rel.split('/').filter(s => s !== '');
    if (segments.length === 0) return true;
    if (segments.some(s => pruned.has(s))) return true;
    return TEMP_FILE.test(segments[segments.length - 1]);
  };
}

/**
 * Carries writes made under the shadow vault's local root by anything
 * OTHER than the vault API up to the remote vault (#429).
 *
 * ## The bug this closes
 *
 * `adapter.basePath` hands out the shadow vault's local root, because
 * plugins that join paths onto it would otherwise crash (#170). But
 * the note tree there is virtual — served from the remote, never
 * mirrored — so a plugin doing
 *
 *     fs.writeFileSync(path.join(adapter.basePath, 'note.md'), body)
 *
 * wrote into a directory nobody reads: the bytes never reached the
 * remote and never entered `vault.fileMap`. The original report (#429)
 * is Claudian, a Claude Code wrapper, and the write does not even come
 * from the renderer — it comes from a child process. That rules out
 * intercepting `fs` inside Obsidian: only a real filesystem watcher
 * sees it.
 *
 * ## Why it is not a sync engine
 *
 * The flow is one-way and event-driven: local disk → remote, through
 * the SAME patched adapter every other write uses, so the existing
 * mtime precondition, conflict resolver and vault-model reflection all
 * apply unchanged. Nothing is pre-fetched, nothing is mirrored, and
 * the remote stays the single source of truth. What the local disk
 * holds is still only what somebody put there.
 *
 * ## Safety rules
 *
 *  - **Two-sample stability.** A path is pushed only once two
 *    consecutive samples, one debounce apart, agree on (size, mtime).
 *    A subprocess streaming a large file out is therefore pushed once,
 *    complete, instead of truncated mid-write.
 *  - **Deletes only for paths we pushed.** A local file disappearing
 *    removes its remote counterpart ONLY if this session pushed that
 *    path. Anything else — a stray cleanup, a path that was never
 *    ours — must never delete a remote note.
 *  - **Ledger.** The (size, mtime) of the last successful push is
 *    remembered so a repeated event for unchanged bytes is not pushed
 *    again.
 */
export class LocalWriteWatcher {
  private closer: { close(): void } | null = null;
  private timer: unknown = null;
  private flushing = false;
  /** Paths with an observed change that has not yet been pushed. */
  private readonly dirty = new Set<string>();
  /** Last sample seen for a dirty path — the other half of the stability check. */
  private readonly sample = new Map<string, string>();
  /** path → signature of the bytes this session last pushed successfully. */
  private readonly pushed = new Map<string, string>();
  /** Paths already reported to the user, so one broken file is not a Notice storm. */
  private readonly reported = new Set<string>();

  constructor(private readonly deps: LocalWriteWatcherDeps) {}

  start(): void {
    if (this.closer) return;
    this.closer = this.deps.watch((rel) => this.onEvent(rel));
    logger.info('LocalWriteWatcher: watching the shadow vault root for out-of-band writes');
  }

  stop(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.closer) {
      try { this.closer.close(); } catch { /* best effort */ }
      this.closer = null;
    }
    this.dirty.clear();
    this.sample.clear();
    this.reported.clear();
  }

  /** Number of paths this session has pushed. Test/diagnostic hook. */
  pushedCount(): number {
    return this.pushed.size;
  }

  private onEvent(rel: string | null): void {
    if (rel === null) {
      // The platform saw *something* but would not say what. Scanning
      // is cheap here precisely because the note tree is virtual: the
      // local root holds the config dir (ignored) and whatever an
      // out-of-band writer put there.
      for (const p of this.deps.scan()) {
        if (!this.deps.ignore(p)) this.dirty.add(p);
      }
    } else {
      const norm = rel.replace(/^\/+/, '');
      if (norm === '' || this.deps.ignore(norm)) return;
      this.dirty.add(norm);
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      // A push is still in flight; come back after it lands rather
      // than interleaving two pushes for the same path.
      this.arm();
      return;
    }
    this.flushing = true;
    const candidates = [...this.dirty];
    this.dirty.clear();
    try {
      for (const rel of candidates) {
        await this.flushOne(rel);
      }
    } finally {
      this.flushing = false;
    }
    if (this.dirty.size > 0) this.arm();
  }

  private async flushOne(rel: string): Promise<void> {
    const st = this.deps.stat(rel);

    if (st === null) {
      this.sample.delete(rel);
      const sig = this.pushed.get(rel);
      if (sig === undefined) return;   // never ours — leave the remote alone
      try {
        await this.deps.removeRemote(rel);
        this.pushed.delete(rel);
        logger.info(`LocalWriteWatcher: "${rel}" deleted locally — removed on the remote`);
      } catch (e) {
        this.fail(rel, `could not delete "${rel}" on the remote: ${errorMessage(e)}`);
      }
      return;
    }

    const sig = `${st.size}:${st.mtimeMs}`;
    if (this.pushed.get(rel) === sig) {
      this.sample.set(rel, sig);
      return;                          // already on the remote, byte-identical
    }
    if (this.deps.isMirroredCopy?.(rel, st)) {
      // We put these bytes there ourselves, materialising the remote's
      // own content. Pushing them back would be an echo — and on a
      // stale copy it would be an echo that overwrites a newer remote.
      this.sample.set(rel, sig);
      return;
    }
    if (this.sample.get(rel) !== sig) {
      // First sighting of this generation. Wait one more debounce and
      // compare again — a file still being written keeps changing.
      this.sample.set(rel, sig);
      this.dirty.add(rel);
      return;
    }
    if (st.size > this.deps.maxBytes) {
      this.fail(
        rel,
        `"${rel}" is ${Math.round(st.size / 1024 / 1024)} MB, over the ` +
        `${Math.round(this.deps.maxBytes / 1024 / 1024)} MB write-back limit — not pushed`,
      );
      // Remember the signature so the same oversized file is not
      // re-reported on every later event for it.
      this.pushed.set(rel, sig);
      return;
    }

    const data = this.deps.read(rel);
    if (data === null) {
      this.sample.delete(rel);
      return;                          // vanished between stat and read
    }
    try {
      await this.deps.push(rel, data);
      this.pushed.set(rel, sig);
      this.reported.delete(rel);
      logger.info(`LocalWriteWatcher: pushed out-of-band write "${rel}" (${data.length} bytes)`);
    } catch (e) {
      this.fail(rel, `could not push "${rel}" to the remote: ${errorMessage(e)}`);
    }
  }

  private fail(rel: string, message: string): void {
    logger.warn(`LocalWriteWatcher: ${message}`);
    if (this.reported.has(rel)) return;
    this.reported.add(rel);
    this.deps.onError?.(rel, message);
  }
}
