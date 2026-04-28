import type { EventRef, TAbstractFile, TFile, Vault } from 'obsidian';

/**
 * `FakeFileExplorer` — Phase C M7.
 *
 * A test double that listens to the same `vault.trigger(...)` event
 * stream Obsidian's real File Explorer + MetadataCache + plugins
 * subscribe to, and maintains a small synthetic model of "what does
 * this vault look like after the events that have fired so far". The
 * Phase C E2E suite (M9) uses it as the **T5 observation point**:
 * once `awaitReflect(path, event)` resolves, an Obsidian-faithful
 * downstream consumer would also have observed the change.
 *
 * Design notes:
 *
 * - **Decoupled from a real Vault.** `attach(vault)` works against
 *   anything that conforms to `VaultLike` (just `on`/`offref`), and
 *   `observe(event, ...args)` lets tests with no Vault at all drive
 *   the model directly.
 *
 * - **History-aware.** A reflect that arrives before
 *   `awaitReflect(...)` is called is still consumed by the next
 *   matching call — eliminates a class of timing flakes where the
 *   bench races the listener registration.
 *
 * - **Fast and deterministic.** Pure JS, no DOM, no real Obsidian
 *   binary; suitable for the unit suite and for M9's per-iter calls
 *   (< 1 s per case is the design target the plan calls out).
 *
 * - **Timing captured at observation, not at await.** `atMs` on the
 *   resolved `awaitReflect` payload is `performance.now()` from the
 *   moment the underlying event fired — that's the value M9 will
 *   feed into PerfAggregator's `S.paint` bucket. Late-arriving
 *   awaits don't inflate the latency.
 */

export type VaultEvent = 'create' | 'modify' | 'delete' | 'rename';

/**
 * Minimal shape FakeFileExplorer needs from a Vault. Real
 * `obsidian.Vault` satisfies this; per-test stubs (FakeVault) only
 * need to expose `on(name, cb): EventRef` and `offref(ref)`.
 */
export type VaultLike = Pick<Vault, 'on' | 'offref'>;

export interface ReflectInfo {
  /** `performance.now()` at the moment the event was observed by the FE. */
  atMs: number;
}

export interface ExplorerSnapshot {
  /** Vault-relative paths currently in the model, sorted ascending. */
  paths: string[];
  /** Map of path → mtime for files that carried a stat at create/modify time. */
  mtimes: Record<string, number>;
}

interface PendingWaiter {
  path: string;
  event: VaultEvent;
  resolve: (info: ReflectInfo) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface HistoryEntry {
  path: string;
  event: VaultEvent;
  atMs: number;
}

const HISTORY_CAP = 1024;

export class FakeFileExplorer {
  private readonly paths = new Set<string>();
  private readonly mtimes = new Map<string, number>();
  private readonly waiters: PendingWaiter[] = [];
  private history: HistoryEntry[] = [];

  /**
   * Subscribe to a real (or real-shaped) Vault's create/modify/delete/
   * rename events. Returns a disposer that calls `vault.offref(...)`
   * for each registration. Idempotent under best-effort error handling.
   */
  attach(vault: VaultLike): () => void {
    // Each `on(...)` call returns its own EventRef; collect them so
    // the disposer can `offref` precisely the listeners it added.
    const refs: EventRef[] = [
      vault.on('create', (file: TAbstractFile) => this.onCreate(file)),
      vault.on('modify', (file: TFile) => this.onModify(file)),
      vault.on('delete', (file: TAbstractFile) => this.onDelete(file)),
      vault.on('rename', (file: TAbstractFile, oldPath: string) => this.onRename(file, oldPath)),
    ];
    return () => {
      for (const ref of refs) {
        try { vault.offref(ref); } catch { /* best effort */ }
      }
    };
  }

  /**
   * Direct event injection — for tests that don't want to stand up a
   * Vault at all. Mirrors the `vault.trigger(event, ...args)` arg
   * shape so a FakeVault's `trigger` can forward straight here.
   */
  observe(event: 'create',  file: TAbstractFile): void;
  observe(event: 'modify',  file: TFile): void;
  observe(event: 'delete',  file: TAbstractFile): void;
  observe(event: 'rename',  file: TAbstractFile, oldPath: string): void;
  observe(event: VaultEvent, ...args: unknown[]): void {
    switch (event) {
      case 'create': this.onCreate(args[0] as TAbstractFile); return;
      case 'modify': this.onModify(args[0] as TFile);         return;
      case 'delete': this.onDelete(args[0] as TAbstractFile); return;
      case 'rename': this.onRename(args[0] as TAbstractFile, args[1] as string); return;
    }
  }

  /**
   * Snapshot of the current synthetic model. Sorted paths give
   * deterministic output for assertions; `mtimes` only carries entries
   * whose source event included a `stat`.
   */
  snapshot(): ExplorerSnapshot {
    return {
      paths: [...this.paths].sort(),
      mtimes: Object.fromEntries(this.mtimes),
    };
  }

  /**
   * Resolve when the next event of `event` for `path` is observed.
   *
   * If a matching event already fired (and hasn't been consumed by an
   * earlier `awaitReflect`), resolves synchronously on the next
   * microtask — eliminates the listener-registration race that would
   * otherwise drop the bench's first iteration.
   *
   * Rejects with a descriptive Error when `timeoutMs` elapses without
   * a match. Default timeout 5 s.
   */
  awaitReflect(path: string, event: VaultEvent, timeoutMs = 5_000): Promise<ReflectInfo> {
    // Walk the history newest → oldest so a recent matching event is
    // preferred over a stale one. Splice on hit so the same event
    // never resolves two awaits.
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.path === path && h.event === event) {
        this.history.splice(i, 1);
        return Promise.resolve({ atMs: h.atMs });
      }
    }

    return new Promise<ReflectInfo>((resolve, reject) => {
      const w: PendingWaiter = {
        path,
        event,
        resolve: (info) => {
          if (w.timer) clearTimeout(w.timer);
          resolve(info);
        },
        reject,
      };
      w.timer = setTimeout(() => {
        this.dropWaiter(w);
        reject(new Error(
          `FakeFileExplorer: no ${event} for "${path}" within ${timeoutMs}ms; ` +
          `history=${JSON.stringify(this.history.slice(-8))}`,
        ));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /**
   * Drop all state and reject any pending awaits. Use in `afterEach`
   * to keep tests hermetic; mid-suite reset is otherwise rare.
   */
  reset(): void {
    this.paths.clear();
    this.mtimes.clear();
    this.history = [];
    for (const w of this.waiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error('FakeFileExplorer: reset() while awaiting reflect'));
    }
  }

  // ── internals ───────────────────────────────────────────────────────

  private onCreate(file: TAbstractFile): void {
    this.paths.add(file.path);
    const mtime = readMtime(file);
    if (mtime !== undefined) this.mtimes.set(file.path, mtime);
    this.recordAndFire('create', file.path);
  }

  private onModify(file: TFile): void {
    // Modify on a path we never saw create for: still record it.
    // VaultModelBuilder's modifyOne only fires when the file existed
    // in fileMap, but the FE shouldn't crash if that invariant slips.
    this.paths.add(file.path);
    if (file.stat) this.mtimes.set(file.path, file.stat.mtime);
    this.recordAndFire('modify', file.path);
  }

  private onDelete(file: TAbstractFile): void {
    this.paths.delete(file.path);
    this.mtimes.delete(file.path);
    // Folders: vault.trigger('delete', folder) fires once for the
    // folder itself; descendants are silently orphaned in fileMap and
    // VaultModelBuilder.removeOne drops them too. Mirror that here so
    // snapshot stays consistent with what File Explorer would show.
    const prefix = file.path + '/';
    for (const p of [...this.paths]) {
      if (p.startsWith(prefix)) {
        this.paths.delete(p);
        this.mtimes.delete(p);
      }
    }
    this.recordAndFire('delete', file.path);
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    // Move the principal entry.
    const oldMtime = this.mtimes.get(oldPath);
    this.paths.delete(oldPath);
    this.mtimes.delete(oldPath);
    this.paths.add(file.path);
    const newMtime = readMtime(file) ?? oldMtime;
    if (newMtime !== undefined) this.mtimes.set(file.path, newMtime);

    // Folders carry descendants — mirror VaultModelBuilder.renameOne's
    // recursive path rewrite.
    const oldPrefix = oldPath + '/';
    const newPrefix = file.path + '/';
    for (const p of [...this.paths]) {
      if (p === file.path) continue;
      if (!p.startsWith(oldPrefix)) continue;
      const moved = newPrefix + p.slice(oldPrefix.length);
      const m = this.mtimes.get(p);
      this.paths.delete(p);
      this.mtimes.delete(p);
      this.paths.add(moved);
      if (m !== undefined) this.mtimes.set(moved, m);
    }

    this.recordAndFire('rename', file.path);
  }

  private recordAndFire(event: VaultEvent, path: string): void {
    const atMs = performance.now();

    // Resolve a matching waiter first (one-shot). If we resolved here
    // we deliberately don't push to history so a *later* awaitReflect
    // can't double-consume the same observation.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.path === path && w.event === event) {
        this.waiters.splice(i, 1);
        w.resolve({ atMs });
        return;
      }
    }

    // No waiter — record so an awaitReflect that arrives *after* the
    // event can still consume it (eliminates the listener-race flake).
    this.history.push({ path, event, atMs });
    if (this.history.length > HISTORY_CAP) {
      this.history.splice(0, this.history.length - HISTORY_CAP);
    }
  }

  private dropWaiter(target: PendingWaiter): void {
    const i = this.waiters.indexOf(target);
    if (i >= 0) this.waiters.splice(i, 1);
  }
}

function readMtime(file: TAbstractFile): number | undefined {
  // TFile carries a `stat`; TFolder doesn't. Duck-type so we don't
  // depend on instanceof checks against the obsidian d.ts (which has
  // no runtime under vitest's node environment).
  const maybeFile = file as Partial<TFile>;
  return maybeFile.stat?.mtime;
}
