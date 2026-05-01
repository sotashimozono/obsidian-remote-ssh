import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import type { EventRef, Vault } from 'obsidian';
import { perfTracer } from '../../src/util/PerfTracer';
import { SftpDataAdapter } from '../../src/adapter/SftpDataAdapter';
import { RpcRemoteFsClient } from '../../src/adapter/RpcRemoteFsClient';
import { ReadCache } from '../../src/cache/ReadCache';
import { DirCache } from '../../src/cache/DirCache';
import { VaultModelBuilder, type ObsidianClassDeps } from '../../src/vault/VaultModelBuilder';
import type { FsChangedParams } from '../../src/proto/types';
import { deployTestDaemon, LOCAL_DAEMON_BINARY, type DeployedDaemon } from './helpers/deployDaemonOnce';
import { TEST_PRIVATE_KEY, TEST_VAULT } from './helpers/makeAdapter';
import { buildRpcClient, type RpcClientHandle } from './helpers/multiclientRpc';
import { FakeFileExplorer } from '../helpers/FakeFileExplorer';
import { assertSyncReflect } from './helpers/assertSyncReflect';

/**
 * Phase C M9 — sync-reflect E2E matrix (foundational slice).
 *
 * Composes the full Phase C pipeline end-to-end in one Node process:
 *
 *   writer SftpDataAdapter (M2 spans)            ← writer-side
 *     → RpcRemoteFsClient.write* (M2 spans)
 *       → daemon (M3 cid correlator + atomicWriteFile)
 *         → fsnotify
 *           → fs.changed notification (M3 envelope meta)
 *             → reader RpcClient.onNotification
 *               → applyFsChange-equivalent (T4a + S.app spans)
 *                 → VaultModelBuilder mutator (T5a span)
 *                   → fakeVault.trigger(create|modify|...)
 *                     → FakeFileExplorer (M7) — the T5 observation
 *                       → assertSyncReflect (M8) — single assertion
 *
 * Cases shipped in this PR (the foundational slice):
 *
 *   - create:       new file at a never-seen path
 *   - delete:       remove a previously-created file
 *   - rename:       move within the same parent
 *
 * Intentionally deferred (will land in M9b/M9c follow-ups):
 *
 *   - modify:       same fsnotify "no IN_MOVED_TO across-watcher
 *                   atomic-rename" quirk that M6's bench skipped
 *                   on; the per-iter re-subscribe workaround needs
 *                   its own design pass.
 *   - large (10 MB) / binary content-hash:    bandwidth bench
 *   - 3-way conflict:                          ThreeWayMergeModal
 *                                              stub or real flow
 *   - disconnect/reconnect:                    OfflineQueue +
 *                                              ReconnectManager
 *                                              orchestration
 *
 * Runs only when the test keypair + daemon binary are staged
 * (`npm run sshd:start` + `npm run build:server`); skipped otherwise.
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}
if (!fs.existsSync(LOCAL_DAEMON_BINARY)) {
  throw new Error(
    `Daemon binary missing at ${LOCAL_DAEMON_BINARY}. ` +
    'Run `npm run build:server` before `npm run test:integration`.',
  );
}

// ── per-suite plumbing ─────────────────────────────────────────────────

const PER_CASE_BUDGET_MS = 3_000;

describe('Phase C E2E — sync reflect matrix', () => {
  let daemon: DeployedDaemon;
  let writer: RpcClientHandle;
  let reader: RpcClientHandle;
  let writerAdapter: SftpDataAdapter;
  let readerAdapter: SftpDataAdapter;

  let harnessVault: HarnessVault;
  let fakeFE: FakeFileExplorer;
  let detachFE: (() => void) | null = null;
  let watchSubId: string | null = null;
  let unsubscribeNotify: (() => void) | null = null;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subdirRel = `e2e-${stamp}`;

  beforeAll(async () => {
    perfTracer.clear();
    perfTracer.setEnabled(true);

    daemon = await deployTestDaemon({ label: 'e2e' });
    writer = await buildRpcClient(daemon.result.remoteSocketPath, daemon.result.token, 'e2e-writer');
    reader = await buildRpcClient(daemon.result.remoteSocketPath, daemon.result.token, 'e2e-reader');

    writerAdapter = new SftpDataAdapter(
      new RpcRemoteFsClient(writer.conn.rpc),
      '',
      new ReadCache({ maxBytes: 64 * 1024 * 1024 }),
      new DirCache(),
      'e2e-writer',
    );
    readerAdapter = new SftpDataAdapter(
      new RpcRemoteFsClient(reader.conn.rpc),
      '',
      new ReadCache({ maxBytes: 64 * 1024 * 1024 }),
      new DirCache(),
      'e2e-reader',
    );

    // Build the reader's synthetic vault + file-explorer surface and
    // wire the M9 reader pipeline (notification → builder → vault.trigger
    // → FakeFileExplorer.observe via attach).
    harnessVault = new HarnessVault();
    fakeFE = new FakeFileExplorer();
    detachFE = fakeFE.attach(harnessVault as unknown as Vault);

    const builder = new VaultModelBuilder(
      harnessVault as unknown as Vault,
      { TFile: HarnessTFile as unknown as ObsidianClassDeps['TFile'],
        TFolder: HarnessTFolder as unknown as ObsidianClassDeps['TFolder'] },
    );

    unsubscribeNotify = reader.conn.rpc.onNotification('fs.changed', (params: FsChangedParams) => {
      // Filter out events from outside our subdir so other integration
      // tests' detritus (or our own setup mkdir) doesn't pollute the
      // assertions.
      if (!params.path.startsWith(subdirRel)) return;
      handleFsChangedForReader(params, builder, readerAdapter);
    });

    // Subscribe to fs.changed on the entire vault (parent dir is
    // already watched by the daemon's startup walk; recursive=true
    // catches new sub-tree creation). Per-case re-subscription is
    // not needed for create/delete/rename cells — only modify hits
    // the "across-watcher atomic-rename swallows IN_MOVED_TO" quirk.
    const subResult = await reader.conn.rpc.call('fs.watch', { path: '', recursive: true });
    watchSubId = subResult.subscriptionId;

    // Bootstrap the FakeVault with the subdir folder so per-case
    // VaultModelBuilder.insertOne(file) can resolve its parent.
    // Done via the writer so the daemon emits a `created` notification
    // → reader handler → builder.insertOne → fakeFE.observe.
    await writerAdapter.mkdir(subdirRel);
    await fakeFE.awaitReflect(subdirRel, 'create', 5_000);
  });

  afterAll(async () => {
    try { detachFE?.(); } catch { /* best effort */ }
    try { unsubscribeNotify?.(); } catch { /* best effort */ }
    if (watchSubId) {
      try { await reader.conn.rpc.call('fs.unwatch', { subscriptionId: watchSubId }); }
      catch { /* daemon may already be down */ }
    }
    try { await writer.close(); } catch { /* best effort */ }
    try { await reader.close(); } catch { /* best effort */ }
    if (daemon) await daemon.teardown();

    perfTracer.setEnabled(false);
    perfTracer.clear();
  });

  beforeEach(() => {
    perfTracer.clear();
  });

  afterEach(() => {
    // Don't reset fakeFE — between cases, the synthetic vault should
    // accumulate state the same way Obsidian's real vault does, so a
    // delete-after-create case can look up the previously-created file.
    // The per-suite stamp keeps cases from colliding on path names.
  });

  // ── cases ───────────────────────────────────────────────────────────

  it('create — writer create reflects on reader\'s FakeFileExplorer', async () => {
    const target = `${subdirRel}/note-create.bin`;
    const data = Buffer.from('hello-create');

    const r = await assertSyncReflect({
      label: 'create',
      op: () => writerAdapter.writeBinary(target, asArrayBuffer(data)),
      reader: { fakeFE },
      expect: { path: target, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    expect(r.e2eMs).toBeGreaterThan(0);
    expect(fakeFE.snapshot().paths).toContain(target);
  });

  it('delete — writer delete reflects as a `delete` event on reader\'s FE', async () => {
    const target = `${subdirRel}/note-delete.bin`;
    const data = Buffer.from('to-be-deleted');
    // Pre-create through the same E2E pipeline so the FakeFE knows
    // the path exists before the deletion under test.
    await assertSyncReflect({
      label: 'delete (pre-create)',
      op: () => writerAdapter.writeBinary(target, asArrayBuffer(data)),
      reader: { fakeFE },
      expect: { path: target, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    const r = await assertSyncReflect({
      label: 'delete',
      op: () => writerAdapter.remove(target),
      reader: { fakeFE },
      expect: { path: target, event: 'delete' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    expect(r.e2eMs).toBeGreaterThan(0);
    expect(fakeFE.snapshot().paths).not.toContain(target);
  });

  it('rename — writer rename reflects as a `rename` event on the new path', async () => {
    const oldPath = `${subdirRel}/note-rename-src.bin`;
    const newPath = `${subdirRel}/note-rename-dst.bin`;
    const data = Buffer.from('renamed');
    await assertSyncReflect({
      label: 'rename (pre-create)',
      op: () => writerAdapter.writeBinary(oldPath, asArrayBuffer(data)),
      reader: { fakeFE },
      expect: { path: oldPath, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    // The daemon's atomic-rename fires `deleted` on the old path AND
    // `created` on the new path; the M3 cid correlator stamps the
    // same cid on both notifications. The reader handler dispatches
    // the `deleted` to builder.removeOne (fires `delete` on FE) and
    // the `created` to builder.insertOne (fires `create` on FE).
    // We assert the `create` on the new path — the visible vault
    // outcome — and verify the old path is gone afterwards.
    const r = await assertSyncReflect({
      label: 'rename',
      op: () => writerAdapter.rename(oldPath, newPath),
      reader: { fakeFE },
      expect: { path: newPath, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    expect(r.e2eMs).toBeGreaterThan(0);
    const snap = fakeFE.snapshot().paths;
    expect(snap).toContain(newPath);
    // Old path may take a beat longer to purge if the `deleted`
    // notification trails behind the `created` one. Give it the
    // same budget as a separate awaitReflect.
    await fakeFE.awaitReflect(oldPath, 'delete', PER_CASE_BUDGET_MS).catch(() => undefined);
    expect(fakeFE.snapshot().paths).not.toContain(oldPath);
  });

  // nested-folder: previously skipped because the daemon's fsnotify
  // auto-watch dropped IN_CREATE for descendants of a directory
  // created via os.MkdirAll (the kernel created the children before
  // the dispatch goroutine got a chance to call notify.Add on the
  // parent). Closed by #107 — the watcher now walks the new sub-tree
  // and emits synthetic `created` events for any descendants caught
  // by the race window. See server/internal/watcher/watcher.go's
  // catchUpAfterRace.
  it('nested-folder — writer write into a deep new sub-tree reflects parents + child', async () => {
    const dir1 = `${subdirRel}/level1`;
    const dir2 = `${subdirRel}/level1/level2`;
    const target = `${dir2}/leaf.bin`;
    const data = Buffer.from('deep');

    const r = await assertSyncReflect({
      label: 'nested-folder',
      op: () => writerAdapter.writeBinary(target, asArrayBuffer(data)),
      reader: { fakeFE },
      expect: { path: target, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS * 2,
    });

    expect(r.e2eMs).toBeGreaterThan(0);
    const snap = fakeFE.snapshot().paths;
    expect(snap).toContain(dir1);
    expect(snap).toContain(dir2);
    expect(snap).toContain(target);
  });
  // ── M9b cases (previously deferred) ──────────────────────────────

  it('modify — writer overwrite reflects as a `modify` event on reader', async () => {
    const target = `${subdirRel}/note-modify.bin`;
    await assertSyncReflect({
      label: 'modify (pre-create)',
      op: () => writerAdapter.writeBinary(target, asArrayBuffer(Buffer.from('v1'))),
      reader: { fakeFE },
      expect: { path: target, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    const r = await assertSyncReflect({
      label: 'modify',
      op: () => writerAdapter.writeBinary(target, asArrayBuffer(Buffer.from('v2'))),
      reader: { fakeFE },
      expect: { path: target, event: 'modify' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    expect(r.e2eMs).toBeGreaterThan(0);
    expect(fakeFE.snapshot().paths).toContain(target);
  });

  it('large file (1 MB) — bandwidth path exercises daemon + reader stat', async () => {
    const target = `${subdirRel}/note-large.bin`;
    const data = Buffer.alloc(1024 * 1024, 0x42);

    const r = await assertSyncReflect({
      label: 'large-file',
      op: () => writerAdapter.writeBinary(target, asArrayBuffer(data)),
      reader: { fakeFE },
      expect: { path: target, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS * 5,
    });

    expect(r.e2eMs).toBeGreaterThan(0);
    expect(fakeFE.snapshot().paths).toContain(target);
  });

  it('binary content-hash round-trip — SHA-256 matches after write → read', async () => {
    const crypto = await import('node:crypto');
    const target = `${subdirRel}/note-binary.bin`;
    // Non-ASCII binary blob with a mix of byte values
    const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const expectedHash = crypto.createHash('sha256').update(data).digest('hex');

    await assertSyncReflect({
      label: 'binary-hash (create)',
      op: () => writerAdapter.writeBinary(target, asArrayBuffer(data)),
      reader: { fakeFE },
      expect: { path: target, event: 'create' },
      budgetMs: PER_CASE_BUDGET_MS,
    });

    // Read back through the reader adapter and compare SHA-256
    const readBack = await readerAdapter.readBinary(target);
    const actualHash = crypto.createHash('sha256').update(Buffer.from(readBack)).digest('hex');
    expect(actualHash).toBe(expectedHash);
  });
});

// ── reader pipeline (mimics main.ts handleFsChanged + applyFsChange) ───

function handleFsChangedForReader(
  params: FsChangedParams,
  builder: VaultModelBuilder,
  readerAdapter: SftpDataAdapter,
): void {
  // T4a — first thing the reader sees after the push frame decodes.
  perfTracer.point('T4a', perfTracer.newCid(), {
    path: params.path,
    event: params.event,
    subscriptionId: params.subscriptionId,
  });

  // applyFsChange runs async (stat for created/modified); fire-and-
  // forget with internal error swallowing so a slow stat doesn't
  // bubble through the RpcClient.
  void (async () => {
    const __t = perfTracer.begin('S.app');
    try {
      switch (params.event) {
        case 'created': {
          const stat = await readerAdapter.stat(params.path).catch(() => null);
          if (!stat) return;
          builder.insertOne({
            path: params.path,
            isDirectory: stat.type === 'folder',
            ctime: stat.ctime ?? 0,
            mtime: stat.mtime ?? 0,
            size: stat.size ?? 0,
          }, { ensureParents: true });
          return;
        }
        case 'modified': {
          const stat = await readerAdapter.stat(params.path).catch(() => null);
          if (stat) {
            builder.modifyOne(params.path, {
              ctime: stat.ctime ?? 0, mtime: stat.mtime ?? 0, size: stat.size ?? 0,
            });
          } else {
            builder.modifyOne(params.path);
          }
          return;
        }
        case 'deleted': {
          builder.removeOne(params.path);
          return;
        }
        case 'renamed': {
          if (!params.newPath) return;
          builder.renameOne(params.path, params.newPath);
          return;
        }
      }
    } finally {
      perfTracer.end(__t, { event: params.event, path: params.path });
    }
  })();
}

// ── HarnessVault: combined VaultModelBuilder target + Events emitter ───

class HarnessTFile {
  vault!: unknown;
  path!: string;
  name!: string;
  basename!: string;
  extension!: string;
  parent!: HarnessTFolder | null;
  stat!: { ctime: number; mtime: number; size: number };
  constructor(vault: unknown, path: string) { this.vault = vault; this.path = path; }
}

class HarnessTFolder {
  vault!: unknown;
  path: string = '';
  name: string = '';
  parent: HarnessTFolder | null = null;
  children: Array<HarnessTFile | HarnessTFolder> = [];
  constructor(vault?: unknown, path?: string) {
    if (vault !== undefined) this.vault = vault;
    if (path !== undefined) this.path = path;
  }
}

interface HarnessRef { name: string; cb: (...args: unknown[]) => void }

/**
 * A FakeVault that satisfies BOTH:
 *   - the slice of `obsidian.Vault` VaultModelBuilder needs
 *     (`fileMap`, `getRoot`, `getAbstractFileByPath`, `trigger`)
 *   - FakeFileExplorer's `VaultLike` (`on` / `offref`)
 *
 * Built inline rather than reused from VaultModelBuilder.test.ts /
 * FakeFileExplorer.test.ts — those FakeVaults each cover only half
 * the surface, and unifying them at this stage would invite churn.
 * If a third caller appears, extract.
 */
class HarnessVault {
  fileMap: Record<string, HarnessTFile | HarnessTFolder> = {};
  private readonly root = new HarnessTFolder(undefined, '');
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly refs = new Map<symbol, HarnessRef>();

  getRoot(): HarnessTFolder { return this.root; }
  getAbstractFileByPath(p: string): HarnessTFile | HarnessTFolder | null {
    return this.fileMap[p] ?? null;
  }

  on(name: string, cb: (...args: unknown[]) => unknown): EventRef {
    const set = this.listeners.get(name) ?? new Set();
    set.add(cb as (...args: unknown[]) => void);
    this.listeners.set(name, set);
    const sym = Symbol(name);
    this.refs.set(sym, { name, cb: cb as (...args: unknown[]) => void });
    return sym as unknown as EventRef;
  }

  offref(ref: EventRef): void {
    const sym = ref as unknown as symbol;
    const r = this.refs.get(sym);
    if (!r) return;
    this.listeners.get(r.name)?.delete(r.cb);
    this.refs.delete(sym);
  }

  trigger(name: string, ...args: unknown[]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(...args); } catch { /* listener crash must not break vault */ }
    }
  }

  // VaultModelBuilder reads `fileMap` directly via a private cast in
  // the production code; we only need to expose the field. No-op.
}

// ── tiny helpers ──────────────────────────────────────────────────────

function asArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
