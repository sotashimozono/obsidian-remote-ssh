import type { DataWriteOptions, ListedFiles, Stat } from 'obsidian';

/**
 * Source extensions whose `getResourcePath` hits the daemon's
 * `fs.thumbnail` path instead of pulling the full original. Matches
 * the daemon's supported decoder set (jpg / png / gif via image.Decode);
 * webp / heic land later (cgo / external libs).
 */
const THUMBNAIL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif']);

/**
 * Default longer-side cap for `getResourcePath` thumbnails. 1024 px
 * is sharp on Retina displays without sending camera-original sizes;
 * a 8 MB JPEG resizes to ~150 KB. Click-to-zoom flows that want the
 * original go through `readBinary`, which never adds the thumb hint.
 */
const DEFAULT_THUMB_MAX_DIM = 1024;

function isThumbnailEligible(vaultPath: string): boolean {
  const dot = vaultPath.lastIndexOf('.');
  if (dot < 0) return false;
  return THUMBNAIL_EXTENSIONS.has(vaultPath.slice(dot + 1).toLowerCase());
}
import * as fs from 'fs';
import { nativeFs } from '../util/nativeFs';
import * as nodePath from 'path';
import { pathToFileURL } from 'url';
import type { MaterializedCache } from './MaterializedCache';
import type { RemoteFsClient } from './RemoteFsClient';
import type { WriterReflector } from './WriterReflector';
import type { LocalOpRegistry } from './LocalOpRegistry';
import type { ReadCache } from '../cache/ReadCache';
import type { DirCache } from '../cache/DirCache';
import type { PathMapper } from '../path/PathMapper';
import type { ResourceBridge } from './ResourceBridge';
import type { RemoteEntry } from '../types';
import type { AncestorTracker } from '../conflict/AncestorTracker';
import type { ConflictResolver } from '../conflict/ConflictResolver';
import type { OfflineQueue, QueuedOp } from '../offline/OfflineQueue';
import type { TransferTracker } from '../util/TransferTracker';
import { logger } from '../util/logger';
import { perfTracer } from '../util/PerfTracer';
import { isPreconditionFailed } from '../proto/rpcError';
import { errorMessage } from "../util/errorMessage";

export type { ThreeWayPanes, TextConflictDecision } from '../conflict/ConflictResolver';

/**
 * Implementation of Obsidian's `DataAdapter` over a `RemoteFsClient`.
 *
 * The client can be either the direct-SFTP path (`SftpRemoteFsClient`
 * wrapping the existing `SftpClient`) or the α path
 * (`RpcRemoteFsClient` talking to `obsidian-remote-server`). The
 * adapter itself stays transport-agnostic.
 *
 * The class is constructed in Phase 4-E, patched onto
 * `app.vault.adapter` in Phase 4-F, and grew its write surface
 * (write/writeBinary/append/process/mkdir/remove/rmdir/rename/copy/
 * trashSystem/trashLocal) in Phase 4-G. Phase 5-D.2 flips the client
 * dependency from the concrete `SftpClient` to the narrow
 * `RemoteFsClient` interface.
 *
 * `getResourcePath` returns a `http://127.0.0.1:<port>/r/<token>?p=…`
 * URL served by an optional `ResourceBridge` (Phase 5-F). When no
 * bridge is wired the method falls back to a `data:` URL with no
 * payload, which Obsidian will fail to render — that's acceptable
 * because resource serving is a feature of the patched adapter, not
 * a hard requirement of the interface.
 *
 * Path translation is currently a straight join of `remoteBasePath`
 * and the vault-relative `normalizedPath`. The per-client user-cache
 * rewrite (Phase 4-J0 / `PathMapper`) will be inserted at this
 * boundary later.
 */
export class SftpDataAdapter {
  constructor(
    private client: RemoteFsClient,
    /** Normalized remote base path (no trailing slash, no leading "~/"). */
    private remoteBasePath: string,
    private readCache: ReadCache,
    private dirCache: DirCache,
    private vaultName: string,
    /**
     * Optional per-client path remapping. When supplied, paths matching
     * the mapper's "private" patterns (e.g. `.obsidian/workspace.json`)
     * are redirected into a per-client subtree on the remote so two
     * machines on the same vault don't clobber each other's UI state.
     * Phase 4-J0.
     */
    private pathMapper: PathMapper | null = null,
    /**
     * Optional localhost HTTP bridge that serves binary content to the
     * Obsidian webview. When supplied, `getResourcePath` returns a
     * bridge URL so `<img>`, `<iframe>`, `<audio>` etc. can render
     * remote-vault assets.
     */
    private resourceBridge: ResourceBridge | null = null,
    /**
     * Optional conflict resolver. When a write fails with
     * `PreconditionFailed` and a resolver is wired, it runs the
     * 3-way merge or two-choice modal flow. When omitted (e.g.
     * unit tests), conflicts surface as the underlying `RpcError`.
     */
    private conflictResolver: ConflictResolver | null = null,
    /**
     * Optional snapshot store: every text read remembers its
     * (content, mtime) here, and a subsequent `PreconditionFailed`
     * write pulls the ancestor out so the 3-way merge UI has all
     * three panes to show. Per-session, never persisted.
     */
    private ancestorTracker: AncestorTracker | null = null,
    /**
     * Optional persistent queue. When supplied, write-side calls that
     * land while `setReconnecting(true)` succeed synthetically (the
     * editor sees the new content via the local read cache) and the
     * op is appended to the queue. The replayer (E2-β.3) drains the
     * queue when the session recovers. When omitted, writes during
     * reconnect throw — the legacy behaviour.
     */
    private offlineQueue: OfflineQueue | null = null,
    /**
     * Absolute filesystem path of the shadow vault's local root. When
     * patched onto `app.vault.adapter`, the `basePath` getter and
     * `getBasePath()` method return this value, so plugins that read
     * `adapter.basePath` (Templater's `tp.file.path`, Kanban's clipboard
     * paste, Importer, Copilot — see `docs/en/user-guide/plugin-compatibility.md`)
     * receive the shadow-vault root (so they don't crash on
     * `undefined`). But the vault tree is virtual — served from the
     * remote, not mirrored to disk — so raw Node `fs` here only touches
     * the local shadow copy: reads miss remote notes, writes don't
     * reach the remote. Only the vault API round-trips (#429).
     *
     * Defaults to `''` for tests that never exercise these members. The
     * production wiring in `main.ts` always passes the real shadow
     * vault root via `(adapter as FileSystemAdapter).getBasePath()`
     * captured before the patch is applied.
     *
     * Survey: PR #165 / docs/en/user-guide/plugin-compatibility.md "basePath compat
     * survey". Implementation: #170.
     */
    private shadowBasePath: string = '',
    /**
     * Optional in-flight transfer tracker. When supplied, large
     * (>1 MB) write/read payloads are registered with the tracker
     * so the StatusBar can display a "transfer in progress" indicator
     * (#127). When omitted (e.g. unit tests), no UI signaling occurs.
     */
    private transferTracker: TransferTracker | null = null,
  ) {}

  /**
   * Mirror of `FileSystemAdapter.basePath`: the shadow-vault local
   * root. The vault tree is virtual (not mirrored to disk), so raw
   * `fs` against this path only touches the local shadow copy — writes
   * don't reach the remote (#429); only the vault API round-trips.
   * #170 returns a defined path so plugins don't crash.
   */
  get basePath(): string {
    return this.shadowBasePath;
  }

  /**
   * Mirror of `FileSystemAdapter.getBasePath()`. Equivalent to the
   * `basePath` getter; both are surveyed-as-used by community plugins
   * (#133, see `docs/en/user-guide/plugin-compatibility.md`).
   */
  getBasePath(): string {
    return this.shadowBasePath;
  }

  /**
   * Bounded on-demand disk cache. Null (the default) leaves every
   * materialisation call a no-op, which is what unit tests and any
   * non-shadow caller want.
   */
  private materializedCache: MaterializedCache | null = null;

  setMaterializedCache(cache: MaterializedCache | null): void {
    this.materializedCache = cache;
  }

  /**
   * True for anything under the vault's config dir.
   *
   * The disk cache must never take ownership of that tree, and the
   * reason is a bug this guard exists to prevent: `pullPluginBinaries`
   * fetches `<configDir>/plugins/<id>/main.js` THROUGH this adapter, so
   * the read-through below would file it in the cache ledger — and the
   * ledger deletes what it owns on eviction and on disconnect. The next
   * launch would then find the plugin gone and silently not load it.
   *
   * `<configDir>/**` already has an owner: `writeThroughConfig` on the
   * way out, the bootstrap's pull/push on the way in. Both keep real
   * files there on purpose.
   */
  private isConfigTree(normalizedPath: string): boolean {
    const dir = this.pathMapper?.configDir;
    if (!dir) return false;
    const rel = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
    return rel === dir || rel.startsWith(`${dir}/`);
  }

  /**
   * Put one file on the shadow disk by fetching it — the asynchronous
   * half of "a request materialises a file", used by the patched
   * `fs.promises.readFile`. Nothing blocks here, so this can take the
   * ordinary read path.
   *
   * Callers that know the size (from the vault model) should check it
   * against the cache limits first; this refuses an over-limit payload
   * after the fact, which costs one transfer.
   */
  async materializeAsync(normalizedPath: string): Promise<boolean> {
    const cache = this.materializedCache;
    if (!cache || cache.disabled()) return false;
    if (this.isConfigTree(normalizedPath)) return false;
    if (cache.has(normalizedPath)) return true;
    const buf = await this.readBuffer(normalizedPath);
    return cache.put(normalizedPath, buf);
  }

  /**
   * Absolute path of a vault file on this device — and, unlike the
   * stock `FileSystemAdapter`, a path that has a real file behind it.
   *
   * The stock implementation just joins onto the base, which over a
   * virtual note tree means handing a plugin a path to nothing (#429).
   * Asking for a full path IS the request that materialises the file:
   * we fetch it synchronously through the ResourceBridge and write it
   * into the bounded cache, so `fs.readFileSync(adapter.getFullPath(p))`
   * works for the file that was asked about. Files over the cache
   * limits are not fetched, and callers still get the joined path —
   * exactly what they got before, no worse.
   */
  getFullPath(normalizedPath: string): string {
    this.materializeSync(normalizedPath);
    return nodePath.join(this.shadowBasePath, normalizedPath);
  }

  /**
   * `file://` URL for a vault file. Same contract as
   * {@link getFullPath}: the file is materialised first, because what
   * follows this URL is usually `<img>`, `shell.openPath` or an
   * external editor — none of which can be intercepted.
   */
  getFilePath(normalizedPath: string): string {
    return pathToFileURL(this.getFullPath(normalizedPath)).href;
  }

  /**
   * Put one file on the shadow disk, synchronously, and report whether
   * it is there afterwards. This is the single "a request came in"
   * entry point: `getFullPath` / `getFilePath` call it, and so does the
   * patched `fs.readFileSync`. Never throws — a caller that wanted a
   * path still gets one, and a caller that wanted bytes falls back to
   * the real filesystem's own ENOENT.
   */
  materializeSync(normalizedPath: string): boolean {
    const cache = this.materializedCache;
    if (!cache || cache.disabled()) return false;
    if (this.isConfigTree(normalizedPath)) {
      // Never ours (see isConfigTree); answer from the real disk only.
      return Boolean(this.shadowBasePath)
        && nativeFs.existsSync(nodePath.join(this.shadowBasePath, normalizedPath));
    }
    if (cache.has(normalizedPath)) return true;
    // Already real on disk — materialised earlier, or written by
    // somebody. One stat, no network.
    if (this.shadowBasePath
      && nativeFs.existsSync(nodePath.join(this.shadowBasePath, normalizedPath))) {
      return true;
    }

    // The ONLY synchronous source of bytes is the in-memory read cache
    // (the note was opened, or written, this session). There is no
    // synchronous way to reach the remote from here, and the obvious
    // one is a trap: `ResourceBridge` runs its HTTP server on THIS
    // event loop, so a blocking request to it can never be answered —
    // the thread that would accept the connection is the thread doing
    // the waiting. An earlier revision of this method shipped exactly
    // that, and it hung connect until the request timed out.
    //
    // So the synchronous surface serves what is already here, and
    // on-demand fetching lives on the async path (`fs.promises.*`,
    // which can simply await `readBinary`).
    const cached = this.readCache.peek(this.toRemote(normalizedPath));
    if (cached) {
      return cache.put(normalizedPath, cached.data);
    }
    return false;
  }

  /**
   * Swap the underlying transport while the adapter stays patched
   * onto `app.vault.adapter`. Used by the reconnect path: an SSH drop
   * tears down the old `RemoteFsClient`, but the adapter object
   * itself is still wired into Obsidian, so we just rebind it to a
   * fresh client (RPC tunnel or SFTP) without going through a
   * restore/re-patch cycle that would force editors to re-render.
   *
   * Caches are preserved — entries are mtime-keyed, so any divergence
   * is caught on the next read.
   */
  swapClient(newClient: RemoteFsClient): void {
    this.client = newClient;
    this.conflictResolver?.swapClient(newClient);
  }

  /** True between the start of a reconnect loop and its terminal state. */
  private reconnecting = false;

  /**
   * Toggle the "reconnecting" gate. While set:
   *  - read / readBinary serve cached values only and throw on miss
   *  - list / stat / exists throw immediately (no cache fallback)
   *  - any write-side method throws with a clear "reconnecting" notice
   *
   * The reconnect manager flips this on at loop start and off at
   * recovered / failed / cancelled. Existing in-flight calls hit
   * the dead transport and reject naturally — only *new* calls are
   * affected by the gate.
   */
  setReconnecting(on: boolean): void {
    this.reconnecting = on;
  }

  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /**
   * Writer-side vault-model reflector (#341). When wired, every
   * mutation that actually lands on the remote is mirrored into the
   * writer's own `vault.fileMap` + `vault.trigger(...)` bus so File
   * Explorer, MetadataCache and open editor tabs follow a title-bar
   * rename (etc.) instead of staying bound to the stale `TFile`.
   *
   * Null by default and wired via `setWriterReflector` rather than a
   * constructor arg: the adapter is constructed before
   * `AdapterManager` knows which transport is active, and the
   * reflector is only meaningful for the SFTP transport (RPC recovers
   * via the `FsChangeListener` daemon echo, so wiring both would
   * double-fire). When null, every reflect call is a no-op — the
   * legacy behaviour, so non-shadow callers are unaffected.
   */
  private writerReflector: WriterReflector | null = null;

  setWriterReflector(reflector: WriterReflector | null): void {
    this.writerReflector = reflector;
  }

  /**
   * Echo-dedup registry (#341, RPC). When set, every applied local
   * mutation records its path(s) here so the RPC `FsChangeListener`
   * drops the daemon's `fs.watch` echo of our own op instead of
   * firing a second `vault.trigger`. Null on the SFTP transport
   * (no daemon, no echo) — recording is then a harmless no-op.
   */
  private localOpRegistry: LocalOpRegistry | null = null;

  setLocalOpRegistry(registry: LocalOpRegistry | null): void {
    this.localOpRegistry = registry;
  }

  /**
   * Run a writer-side reflect, swallowing + logging any throw. By the
   * time this runs the remote op has already succeeded; a reflector
   * fault (or a vault listener that throws — Obsidian wraps each
   * `Events.trigger` handler in its own try/catch, but a fault inside
   * `VaultModelBuilder` itself would still land here) must not surface
   * to the editor as a write failure and provoke a spurious retry /
   * duplicate remote write. Centralising the guard also keeps the
   * call sites to one line.
   *
   * The log includes the error's class name so a systematic bug
   * (`TypeError` from a model-builder defect) is distinguishable in
   * the log stream from a transient listener fault — the two need
   * very different triage.
   */
  private reflect(run: (r: WriterReflector) => void): void {
    const r = this.writerReflector;
    if (!r) return;
    try {
      run(r);
    } catch (e) {
      const kind = e instanceof Error ? e.name : typeof e;
      logger.warn(
        `SftpDataAdapter: writer reflect failed [${kind}]: ${errorMessage(e)}`,
      );
    }
  }

  /**
   * Post-success bookkeeping for a local mutation that actually hit
   * the remote: (1) record the affected path(s) so the RPC echo of
   * our own op is de-duped, then (2) reflect it into the writer's
   * vault model. Order matters — the record is synchronous and must
   * land before the daemon's later echo can arrive. Both steps are
   * best-effort and never surface to the editor as a write failure.
   *
   * `echoPaths` is what the daemon's `fs.changed` frame will name
   * (rename echoes both old + new, possibly as separate events).
   */
  private applied(echoPaths: string[], run: (r: WriterReflector) => void): void {
    this.localOpRegistry?.record(echoPaths);
    this.reflect(run);
  }

  // ─── DataAdapter (read-side) ─────────────────────────────────────────────

  getName(): string {
    return this.vaultName;
  }

  async exists(normalizedPath: string, _sensitive?: boolean): Promise<boolean> {
    if (this.reconnecting) throw reconnectingError();
    return this.client.exists(this.toRemote(normalizedPath));
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    if (this.reconnecting) throw reconnectingError();
    try {
      const s = await this.client.stat(this.toRemote(normalizedPath));
      return {
        type: s.isDirectory ? 'folder' : 'file',
        // SFTP only exposes mtime; reuse it as ctime so callers get a
        // monotonically reasonable value rather than 0.
        ctime: s.mtime,
        mtime: s.mtime,
        size: s.size,
      };
    } catch {
      return null;
    }
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    if (this.reconnecting) throw reconnectingError();
    const plan = this.planList(normalizedPath);
    const primaryRemote = this.joinRemote(plan.primary);

    let primaryEntries = this.dirCache.get(primaryRemote);
    if (!primaryEntries) {
      primaryEntries = await this.client.list(primaryRemote);
      this.dirCache.put(primaryRemote, primaryEntries);
    }
    if (plan.hideUserDirName) {
      primaryEntries = primaryEntries.filter(e => e.name !== plan.hideUserDirName);
    }

    let userEntries: RemoteEntry[] = [];
    if (plan.mergeFromUser && plan.userSubtree) {
      const userRemote = this.joinRemote(plan.userSubtree);
      let cached = this.dirCache.get(userRemote);
      if (!cached) {
        try {
          cached = await this.client.list(userRemote);
          this.dirCache.put(userRemote, cached);
        } catch {
          // The per-client subtree doesn't exist yet — that's fine on
          // first connect, no entries to merge.
          cached = [];
        }
      }
      userEntries = cached;
    }

    const files: string[] = [];
    const folders: string[] = [];
    const prefix = normalizedPath ? normalizedPath + '/' : '';
    const seen = new Set<string>();
    const emit = (entry: RemoteEntry) => {
      if (seen.has(entry.name)) return;
      seen.add(entry.name);
      const childPath = prefix + entry.name;
      if (entry.isDirectory) folders.push(childPath);
      else files.push(childPath);
    };
    // The user-subtree entries take precedence — their names always
    // appear in the merged listing, even if a same-named placeholder
    // somehow exists in the primary listing.
    for (const e of userEntries) emit(e);
    for (const e of primaryEntries) emit(e);
    return { files, folders };
  }

  /**
   * Wrapper that lets the test suite see what the path mapper
   * decided about a given list request without going through a real
   * RemoteFsClient.
   */
  planList(normalizedPath: string): {
    primary: string;
    mergeFromUser: boolean;
    userSubtree?: string;
    hideUserDirName?: string;
  } {
    if (this.pathMapper) {
      return this.pathMapper.resolveListing(normalizedPath);
    }
    return { primary: normalizedPath, mergeFromUser: false };
  }

  async read(normalizedPath: string): Promise<string> {
    const buf = await this.readBuffer(normalizedPath);
    const text = buf.toString('utf8');
    // Snapshot the just-read content so a subsequent conflicting write
    // can show the user a real ancestor pane in the 3-way modal.
    if (this.ancestorTracker) {
      const cached = this.readCache.peek(this.toRemote(normalizedPath));
      this.ancestorTracker.remember(normalizedPath, text, cached?.mtime ?? 0);
    }
    return text;
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const buf = await this.readBuffer(normalizedPath);
    // Copy into a fresh ArrayBuffer so callers can't accidentally mutate
    // the cached Buffer's underlying memory through the returned view.
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return ab;
  }

  /**
   * URL the Obsidian webview should fetch to render this asset. If
   * the ResourceBridge is wired, the URL hits its localhost server
   * (which calls back into this adapter's `readBinary` for the bytes,
   * with all the cache + path-mapping logic intact). Without a bridge
   * we hand back an empty `data:` URL — the asset won't render, but
   * the read path is the only one that actually needs the bridge.
   */
  getResourcePath(normalizedPath: string): string {
    if (this.resourceBridge && this.resourceBridge.isRunning()) {
      // Image extensions get a thumbnail hint so the bridge can route
      // through the daemon's resize path. The bridge falls back to the
      // full binary transparently on SFTP sessions or pre-thumbnail
      // daemons, so this is safe regardless of transport.
      const thumbMaxDim = isThumbnailEligible(normalizedPath) ? DEFAULT_THUMB_MAX_DIM : undefined;
      return this.resourceBridge.urlFor(normalizedPath, { thumbMaxDim });
    }
    return 'data:application/octet-stream;base64,';
  }

  /**
   * Read a vault-relative binary asset and hand back a `Uint8Array`.
   * Wraps `readBinary` for the bridge's GET handler — ArrayBuffer ↔
   * Uint8Array is just a view, not a copy.
   */
  async fetchBinaryForBridge(normalizedPath: string): Promise<Uint8Array> {
    const ab = await this.readBinary(normalizedPath);
    return new Uint8Array(ab);
  }

  // ─── DataAdapter (write-side) ────────────────────────────────────────────

  async write(normalizedPath: string, data: string, _options?: DataWriteOptions): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        await this.queueOrThrowText(normalizedPath, data);
        return;
      }
      await this.writeBuffer(normalizedPath, Buffer.from(data, 'utf8'), true);
      // After a successful text write, the file we just wrote IS the
      // new ancestor for any later edit cycle.
      if (this.ancestorTracker) {
        const cached = this.readCache.peek(this.toRemote(normalizedPath));
        this.ancestorTracker.remember(normalizedPath, data, cached?.mtime ?? 0);
      }
      this.applied([normalizedPath], r => r.reflectWrite(normalizedPath));
    } finally {
      perfTracer.end(__t1, { op: 'write', path: normalizedPath, bytes: data.length });
    }
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        await this.queueOrThrowBinary(normalizedPath, Buffer.from(data));
        return;
      }
      await this.writeBuffer(normalizedPath, Buffer.from(data), false);
      this.applied([normalizedPath], r => r.reflectWrite(normalizedPath));
    } finally {
      perfTracer.end(__t1, { op: 'writeBinary', path: normalizedPath, bytes: data.byteLength });
    }
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        // Read locally (cache-only via readBuffer's reconnecting branch),
        // splice, then queue as a full write. Reading + writing as
        // separate ops would explode the queue size when the editor
        // appends in a tight loop.
        let existing = '';
        try { existing = await this.read(normalizedPath); }
        catch { /* file did not exist; start empty so append acts like create */ }
        await this.queueOrThrowText(normalizedPath, existing + data);
        return;
      }
      let existing = '';
      try { existing = await this.read(normalizedPath); }
      catch { /* file did not exist; start empty so append acts like create */ }
      await this.write(normalizedPath, existing + data, options);
    } finally {
      perfTracer.end(__t1, { op: 'append', path: normalizedPath, bytes: data.length });
    }
  }

  async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        let existing: Buffer;
        try { existing = await this.readBuffer(normalizedPath); }
        catch { existing = Buffer.alloc(0); }
        const merged = Buffer.concat([existing, Buffer.from(data)]);
        await this.queueOrThrowBinary(normalizedPath, merged);
        return;
      }
      let existing: Buffer;
      try { existing = await this.readBuffer(normalizedPath); }
      catch { existing = Buffer.alloc(0); }
      const merged = Buffer.concat([existing, Buffer.from(data)]);
      await this.writeBuffer(normalizedPath, merged, false);
      // appendBinary writes through writeBuffer directly (not via
      // this.write/writeBinary), so it must reflect itself or the
      // writer's model misses binary appends (#341).
      this.applied([normalizedPath], r => r.reflectWrite(normalizedPath));
      void options;
    } finally {
      perfTracer.end(__t1, { op: 'appendBinary', path: normalizedPath, bytes: data.byteLength });
    }
  }

  /**
   * Read, transform, and write back a plaintext file. Not atomic across
   * concurrent writers — same caveat as the underlying SFTP write (which
   * goes through a tmp+rename inside SftpClient).
   */
  async process(
    normalizedPath: string,
    fn: (data: string) => string,
    options?: DataWriteOptions,
  ): Promise<string> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      if (this.reconnecting) {
        const current = await this.read(normalizedPath);
        const next = fn(current);
        await this.queueOrThrowText(normalizedPath, next);
        return next;
      }
      const current = await this.read(normalizedPath);
      const next = fn(current);
      await this.write(normalizedPath, next, options);
      return next;
    } finally {
      perfTracer.end(__t1, { op: 'process', path: normalizedPath });
    }
  }

  async mkdir(normalizedPath: string): Promise<void> {
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'mkdir', path: normalizedPath });
      return;
    }
    const remote = this.toRemote(normalizedPath);
    await this.client.mkdirp(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
    this.applied([normalizedPath], r => r.reflectMkdir(normalizedPath));
  }

  async remove(normalizedPath: string): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      const remote = this.toRemote(normalizedPath);
      if (this.reconnecting) {
        await this.queueOrThrowMutation({ kind: 'remove', path: normalizedPath });
      } else {
        await this.client.remove(remote);
      }
      this.invalidatePath(remote);
      this.ancestorTracker?.invalidate(normalizedPath);
      // Reflect only when the delete actually hit the remote. While
      // reconnecting the op is merely queued; mirroring the model now
      // would drop the entry locally even though the file still
      // exists remotely, and a failed replay would leave them
      // permanently diverged (the QueueReplayer path does not
      // re-reflect).
      if (!this.reconnecting) this.applied([normalizedPath], r => r.reflectRemove(normalizedPath));
    } finally {
      perfTracer.end(__t1, { op: 'remove', path: normalizedPath });
    }
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'rmdir', path: normalizedPath, recursive });
    } else {
      await this.client.rmdir(remote, recursive);
      // AncestorTracker doesn't have prefix invalidation today; in
      // practice rmdir kills folders that the user wasn't editing as
      // text, so the stale entries (if any) just live until LRU pushes
      // them out. Cheap to add later if it ever matters.
    }
    this.invalidateTree(remote);
    // See `remove`: only mirror once the rmdir actually applied.
    if (!this.reconnecting) this.applied([normalizedPath], r => r.reflectRemove(normalizedPath));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const __t1 = perfTracer.begin('S.adp');
    try {
      const oldRemote = this.toRemote(oldPath);
      const newRemote = this.toRemote(newPath);
      if (this.reconnecting) {
        await this.queueOrThrowMutation({ kind: 'rename', oldPath, newPath });
      } else {
        await this.client.mkdirp(parentDirRemote(newRemote));
        await this.client.rename(oldRemote, newRemote);
      }
      this.invalidateTree(oldRemote);
      this.invalidatePath(newRemote);
      // Keep the ancestor for `newPath` if one happens to exist (e.g.
      // rename onto an open file) — the user's edit cycle is against
      // whatever they last read at that path, regardless of how the
      // file got there.
      this.ancestorTracker?.invalidate(oldPath);
      // See `remove`: only mirror once the rename actually applied.
      // Echo both paths — some watchers split a rename into
      // delete(old) + create(new).
      if (!this.reconnecting) this.applied([oldPath, newPath], r => r.reflectRename(oldPath, newPath));
    } finally {
      perfTracer.end(__t1, { op: 'rename', path: oldPath, newPath });
    }
  }

  async copy(oldPath: string, newPath: string): Promise<void> {
    const newRemote = this.toRemote(newPath);
    if (this.reconnecting) {
      await this.queueOrThrowMutation({ kind: 'copy', srcPath: oldPath, dstPath: newPath });
    } else {
      const oldRemote = this.toRemote(oldPath);
      await this.client.mkdirp(parentDirRemote(newRemote));
      await this.client.copy(oldRemote, newRemote);
    }
    this.invalidatePath(newRemote);
  }

  /**
   * SFTP has no concept of a system trash. Return false so Obsidian falls
   * through to its local-trash flow (`trashLocal`); we don't perform any
   * destructive action here.
   */
  trashSystem(_normalizedPath: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Move the path under `<vault>/.trash/`, mirroring Obsidian's local-trash
   * behaviour but on the remote. Existing files at the target are
   * overwritten; existing directories cause the rename to fail (that
   * matches the desktop behaviour).
   */
  async trashLocal(normalizedPath: string): Promise<void> {
    // Implemented as a rename under .trash/; the rename method
    // already handles the reconnecting → queue path on its own, so we
    // just delegate.
    const trashedPath = '.trash/' + normalizedPath;
    await this.rename(normalizedPath, trashedPath);
  }

  // ─── internals ───────────────────────────────────────────────────────────

  // ─── offline queue replay (E2-β.3) ─────────────────────────────────────

  /**
   * Drive a single queued op against the live remote. Used by
   * `QueueReplayer` once the SSH session has recovered. Differs from
   * the regular write path in that it honours the queued op's
   * `expectedMtime` (= the mtime the file had when the user started
   * typing) rather than whatever the cache currently holds.
   *
   * Outcomes:
   *
   *   - `ok` — the op landed cleanly (or the user picked
   *     `keep-mine` / `merged` in the 3-way modal).
   *   - `conflict` — the user cancelled the conflict modal or chose
   *     `keep-theirs`; the op should be considered NOT-fulfilled,
   *     but the queue entry can still be marked completed because
   *     the user has actively decided not to apply it.
   *   - `error` — anything else (network, permission, etc.). The
   *     queue entry stays pending so the next reconnect can retry.
   */
  async replayQueuedOp(op: QueuedOp): Promise<{ result: 'ok' } | { result: 'conflict' } | { result: 'error'; message: string }> {
    if (this.reconnecting) {
      return { result: 'error', message: 'replayQueuedOp called while reconnecting' };
    }
    try {
      switch (op.kind) {
        case 'write': {
          const data = Buffer.from(op.contentBase64, 'base64');
          await this.writeBuffer(op.path, data, true, op.expectedMtime);
          return { result: 'ok' };
        }
        case 'writeBinary': {
          const data = Buffer.from(op.contentBase64, 'base64');
          await this.writeBuffer(op.path, data, false, op.expectedMtime);
          return { result: 'ok' };
        }
        case 'append': {
          const data = Buffer.from(op.contentBase64, 'base64').toString('utf8');
          await this.append(op.path, data);
          return { result: 'ok' };
        }
        case 'appendBinary': {
          const data = Buffer.from(op.contentBase64, 'base64');
          const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          await this.appendBinary(op.path, ab);
          return { result: 'ok' };
        }
        case 'mkdir':
          await this.mkdir(op.path);
          return { result: 'ok' };
        case 'remove':
          await this.remove(op.path);
          return { result: 'ok' };
        case 'rmdir':
          await this.rmdir(op.path, op.recursive);
          return { result: 'ok' };
        case 'rename':
          await this.rename(op.oldPath, op.newPath);
          return { result: 'ok' };
        case 'copy':
          await this.copy(op.srcPath, op.dstPath);
          return { result: 'ok' };
        case 'trashLocal':
          await this.trashLocal(op.path);
          return { result: 'ok' };
      }
    } catch (e) {
      const msg = errorMessage(e);
      // The 3-way merge path's `cancel` and `keep-theirs` branches
      // rethrow the original PreconditionFailed; treat that as a
      // user-driven decision rather than an error so the queue can
      // mark the entry done and move on.
      if (isPreconditionFailed(e)) {
        return { result: 'conflict' };
      }
      return { result: 'error', message: msg };
    }
  }

  // ─── offline queue helpers (E2-β) ──────────────────────────────────────

  /**
   * Append a text write to the offline queue and refresh local
   * caches so the editor sees the just-written content. Throws the
   * legacy `reconnecting` error when no queue is wired.
   *
   * The queued op carries `expectedMtime` (the cached mtime at
   * enqueue time — i.e. the mtime the file had when the user started
   * typing) so the replayer can route through the 3-way merge UI on
   * conflict-during-replay.
   *
   * The ancestor tracker is intentionally NOT refreshed here:
   * keeping the original "what user read" snapshot is what makes the
   * eventual conflict modal useful. Refreshing it would erase the
   * pre-edit content and the user would see (mine, mine, theirs) —
   * useless for a real merge decision.
   */
  private async queueOrThrowText(normalizedPath: string, data: string): Promise<void> {
    if (!this.offlineQueue) throw reconnectingError();
    const remote = this.toRemote(normalizedPath);
    const cached = this.readCache.peek(remote);
    const buf = Buffer.from(data, 'utf8');
    await this.offlineQueue.enqueue({
      kind: 'write',
      path: normalizedPath,
      contentBase64: buf.toString('base64'),
      expectedMtime: cached?.mtime,
    });
    const synthMtime = Date.now();
    this.readCache.put(remote, buf, synthMtime);
  }

  /** Binary equivalent of `queueOrThrowText`; the ancestor tracker is text-only so it's left alone. */
  private async queueOrThrowBinary(normalizedPath: string, buf: Buffer): Promise<void> {
    if (!this.offlineQueue) throw reconnectingError();
    const remote = this.toRemote(normalizedPath);
    const cached = this.readCache.peek(remote);
    await this.offlineQueue.enqueue({
      kind: 'writeBinary',
      path: normalizedPath,
      contentBase64: buf.toString('base64'),
      expectedMtime: cached?.mtime,
    });
    const synthMtime = Date.now();
    this.readCache.put(remote, buf, synthMtime);
  }

  /**
   * Append a non-write mutation (mkdir / remove / rmdir / rename /
   * copy) to the offline queue. Cache invalidation lives in each
   * caller because the right invalidation differs by op shape.
   */
  private async queueOrThrowMutation(op: QueuedOp): Promise<void> {
    if (!this.offlineQueue) throw reconnectingError();
    await this.offlineQueue.enqueue(op);
  }

  /**
   * Fetch (or revalidate) the file's contents.
   *
   * If the cache has an entry, stat the remote and reuse the cached buffer
   * when mtimes agree. Otherwise read the file, then opportunistically
   * stat it so the cache entry has a real mtime to compare against next
   * time. The opportunistic stat after a fresh read is best-effort: a
   * failure is logged but does not block the read result.
   */
  private async readBuffer(normalizedPath: string): Promise<Buffer> {
    const remote = this.toRemote(normalizedPath);
    const cached = this.readCache.peek(remote);

    // While reconnecting we can't talk to the remote at all. Serve
    // whatever is already in the cache so already-open editors keep
    // working; throw on a miss rather than block forever.
    if (this.reconnecting) {
      if (cached) {
        this.readCache.get(remote); // bump LRU on hit
        return cached.data;
      }
      throw reconnectingError();
    }

    if (cached) {
      const s = await this.client.stat(remote);
      // Revalidate on mtime AND size. mtime alone is not enough: SFTP reports
      // it at 1-second resolution (`SftpClient`: `mtime: stats.mtime * 1000`),
      // so two edits inside the same wall-clock second collapse onto the same
      // value — and we would serve a cached copy of a file that no longer
      // exists on the server, then let the user save it back over the real one.
      // `stat` already hands us the size (it is used just below to size the
      // transfer), so comparing it costs nothing and catches every same-second
      // edit that changed the length.
      //
      // Not a theoretical race: `reflect.spec.ts` sleeps 1.1 s between remote
      // edits to keep itself green — this bug wearing a workaround. Pinned by
      // `e2e/cache-pressure.spec.ts`.
      //
      // A same-second edit that preserves the byte length is still invisible
      // here; closing that needs a content hash or a server-side change
      // counter. This removes the common case, cheaply.
      const sizeMatches = s.size === undefined || s.size === cached.data.byteLength;
      if (s.mtime === cached.mtime && sizeMatches) {
        this.readCache.get(remote); // bump LRU on hit
        return cached.data;
      }
      // Stat tells us the size so we can register a tracked download
      // before paying the bandwidth.
      const txId = this.transferTracker?.begin('down', normalizedPath, s.size ?? 0) ?? null;
      try {
        const data = await this.client.readBinary(remote);
        this.readCache.put(remote, data, s.mtime);
        return data;
      } finally {
        this.transferTracker?.end(txId);
      }
    }

    const data = await this.client.readBinary(remote);
    let mtime = 0;
    try {
      const s = await this.client.stat(remote);
      mtime = s.mtime;
    } catch (e) {
      logger.warn(`stat-after-read failed for "${remote}": ${errorMessage(e)}`);
    }
    this.readCache.put(remote, data, mtime);
    return data;
  }

  /**
   * Atomic-on-the-server write through SftpClient (tmp+rename). Ensures
   * the parent directory exists, then refreshes the read cache with the
   * just-written content using the freshly-read mtime.
   *
   * When the adapter has a recent ReadCache entry for this path, the
   * cached mtime is sent as `expectedMtime` so the server rejects the
   * write if another client wrote in between. On rejection the
   * conflict-resolution stack runs:
   *
   *   1. If `isText` AND we have an ancestor snapshot AND a 3-way
   *      callback, present `(ancestor, mine, theirs)` to the user.
   *      Their decision either clobbers, replaces with theirs,
   *      writes a hand-merged version, or cancels.
   *   2. Else, fall back to the legacy `onWriteConflict` (overwrite
   *      or cancel) — used by binary writes and by text writes that
   *      have no ancestor (e.g. write-without-prior-read).
   *   3. Else, rethrow the precondition error.
   *
   * `data` may be reassigned in the merged-decision branch so the
   * post-write cache update reflects what actually landed on disk.
   *
   * `expectedMtimeOverride` lets the offline-queue replayer
   * (E2-β.3) feed in the mtime captured at *enqueue* time rather
   * than whatever the cache holds now (which is the synthetic
   * mtime from the offline cache update).
   */
  /**
   * Mirror a successful `<configDir>/**` write onto the LOCAL shadow disk
   * (#342 / #429 — "plugin settings are not kept after restarting the vault").
   *
   * Why this is load-bearing, and why a pull-on-connect cannot replace it:
   * Obsidian loads community plugins during startup, and each plugin's
   * `onload()` calls `Plugin.loadData()` — which reads
   * `<configDir>/plugins/<id>/data.json` — BEFORE remote-ssh has connected
   * over SSH and patched the adapter. That read therefore always hits the
   * real `FileSystemAdapter`, i.e. the local shadow disk. We cannot get in
   * front of it: the SSH connect is async and happens at layout-ready.
   *
   * So the local disk must ALREADY be correct at startup. Previously nothing
   * ever wrote it: `saveData()` went through the patched adapter straight to
   * the remote and the local copy stayed empty, so every restart booted the
   * plugin on DEFAULTS — which the plugin then saved back, destroying the
   * real settings on the remote too.
   *
   * Write-through fixes that at the source: local disk is a warm cache of the
   * remote, so whichever way the shadow window is launched (Connect from the
   * source window, or reopening the vault directly) the startup read sees the
   * settings this device last saved. The remote per-device copy stays the
   * source of truth and the cross-session backup.
   *
   * Scope is deliberately `<configDir>/**` only — the vault's NOTE tree stays
   * virtual (served from the remote, never mirrored to disk); mirroring it
   * would defeat the whole shadow-vault design. Best-effort: a failure here
   * must never fail the write that already landed on the remote.
   */
  private writeThroughConfig(normalizedPath: string, data: Buffer): void {
    if (!this.shadowBasePath || !this.pathMapper) return;
    const rel = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
    if (!rel.startsWith(`${this.pathMapper.configDir}/`)) return;

    // Containment must be checked on the RESOLVED path, not the raw string:
    // the prefix test above is a plain `startsWith`, so `.obsidian/x/../../../
    // evil` would sail past it and `join` would then resolve the `..` right
    // out of the shadow root. `resolve` also collapses win32 backslashes,
    // which would otherwise be a second way to smuggle a separator through.
    // The vault path reaches us from Obsidian / other plugins — not trusted.
    const root = nodePath.resolve(this.shadowBasePath);
    const abs = nodePath.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + nodePath.sep)) {
      logger.warn(`writeThroughConfig: refusing to mirror outside the shadow root: "${rel}"`);
      return;
    }

    try {
      // NEVER write through a symlink. `ShadowVaultBootstrap.installPlugin`
      // symlinks remote-ssh's OWN main.js / manifest.json / styles.css in the
      // shadow vault back to the SOURCE vault's real files, and
      // `fs.writeFileSync` follows symlinks — mirroring one would overwrite
      // the source vault's plugin install and brick it. That is exactly the
      // bug class #455 just fixed; do not reintroduce it here.
      //
      // Skipping costs nothing: the remote write already succeeded, and for
      // plugin CODE the local copy is owned by the pull/push binary
      // round-trip (`PLUGIN_BINARY_FILES`), not by this cache.
      if (nativeFs.lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) {
        logger.warn(`writeThroughConfig: "${rel}" is a symlink — not mirrored (would clobber its target)`);
        return;
      }
      // Same hazard one level up: a symlinked ANCESTOR (e.g. a stale
      // whole-dir plugin symlink from an older build) would redirect the
      // write out of the shadow root even though `abs` looked contained.
      const dir = nodePath.dirname(abs);
      const realDir = nativeFs.existsSync(dir) ? nativeFs.realpathSync(dir) : null;
      if (realDir && realDir !== root && !realDir.startsWith(root + nodePath.sep)) {
        logger.warn(`writeThroughConfig: "${rel}" resolves outside the shadow root via a symlinked parent — not mirrored`);
        return;
      }

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(abs, data);
    } catch (e) {
      // The remote write already succeeded — the session is correct either
      // way; only the next restart's warm start is degraded.
      logger.warn(`writeThroughConfig: "${rel}" not mirrored locally (${errorMessage(e)})`);
    }
  }

  private async writeBuffer(
    normalizedPath: string,
    data: Buffer,
    isText: boolean,
    expectedMtimeOverride?: number,
  ): Promise<void> {
    const remote = this.toRemote(normalizedPath);
    const parent = parentDirRemote(remote);
    if (parent && parent !== remote) {
      await this.client.mkdirp(parent);
    }

    const cached = this.readCache.peek(remote);
    const expectedMtime = expectedMtimeOverride ?? cached?.mtime;
    let writtenData = data;
    const txId = this.transferTracker?.begin('up', normalizedPath, data.length) ?? null;
    try {
      try {
        await this.client.writeBinary(remote, writtenData, expectedMtime);
      } catch (e) {
        if (expectedMtime === undefined || !isPreconditionFailed(e) || !this.conflictResolver) {
          throw e;
        }
        writtenData = await this.conflictResolver.resolve(
          normalizedPath, remote, writtenData, isText, e,
        );
      }
    } finally {
      this.transferTracker?.end(txId);
    }

    // The remote now holds `writtenData`. Mirror it onto the local shadow
    // disk too, so the next Obsidian start reads the real settings (#342/#429).
    this.writeThroughConfig(normalizedPath, writtenData);

    let mtime = 0;
    try {
      const s = await this.client.stat(remote);
      mtime = s.mtime;
    } catch (e) {
      logger.warn(`stat-after-write failed for "${remote}": ${errorMessage(e)}`);
    }
    this.readCache.put(remote, writtenData, mtime);
    this.dirCache.invalidate(parent);
  }


  /**
   * Drop cache entries for a path the daemon just reported as
   * changed via an `fs.changed` push. The argument is the daemon's
   * vault-relative path (already past PathMapper for private files);
   * the adapter joins it with `remoteBasePath` to recover the cache
   * key it actually stored under.
   */
  invalidateRemotePath(remoteVaultPath: string): void {
    this.invalidatePath(this.joinRemote(remoteVaultPath));
  }

  /**
   * Resolve a vault-relative path to the absolute path on the remote.
   *
   * If a PathMapper is attached, private vault paths are first
   * redirected into the per-client subtree (`.obsidian/workspace.json`
   * → `.obsidian/user/<id>/workspace.json`) so two machines on the
   * same vault don't trample each other's UI state. The mapped result
   * is then joined with `remoteBasePath` to form the full path the
   * `RemoteFsClient` sees.
   */
  toRemote(normalizedPath: string): string {
    const mapped = this.pathMapper
      ? this.pathMapper.toRemote(normalizedPath)
      : normalizedPath;
    return this.joinRemote(mapped);
  }

  /** Invalidate read + dir caches for a single remote path. */
  private invalidatePath(remote: string): void {
    this.readCache.invalidate(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
  }

  /** Prefix-invalidate read + dir caches for a remote subtree. */
  private invalidateTree(remote: string): void {
    this.readCache.invalidatePrefix(remote);
    this.dirCache.invalidatePrefix(remote);
    this.dirCache.invalidate(parentDirRemote(remote));
  }

  private joinRemote(vaultRelative: string): string {
    if (!vaultRelative || vaultRelative === '/') return this.remoteBasePath;
    if (this.remoteBasePath === '') return vaultRelative;
    if (this.remoteBasePath === '/') return '/' + vaultRelative;
    return `${this.remoteBasePath}/${vaultRelative}`;
  }
}

/**
 * Parent directory of a remote path. Handles absolute (`/foo/bar` → `/foo`),
 * relative (`foo/bar` → `foo`), and edge cases (`/foo` → `/`, `foo` → ``,
 * `/` → `/`, `` → ``).
 */
function parentDirRemote(p: string): string {
  if (p === '' || p === '/') return p;
  const i = p.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return p.slice(0, i);
}

/**
 * Stable error thrown by every adapter method while a reconnect is
 * in flight. Distinguishes the "remote is temporarily unavailable"
 * case from "file not found" / "permission denied" so callers (and
 * the Obsidian editor in particular) can surface a friendly notice
 * rather than a generic IO failure.
 */
function reconnectingError(): Error {
  return new Error('Remote SSH: reconnecting — try again once the connection is restored');
}

