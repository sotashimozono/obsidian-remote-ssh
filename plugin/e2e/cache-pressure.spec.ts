import { test, expect, type Page } from '@playwright/test';
import {
  launchObsidian,
  connectAndWaitForShadowVault,
  findShadowVaultPath,
  waitForShadowVaultLoaded,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';
import * as crypto from 'node:crypto';

/**
 * Cache pressure — the ReadCache/DirCache correctness surface when the working
 * set does NOT fit in the cache.
 *
 * Why this spec exists
 * -------------------
 * `AdapterManager.patch()` builds both caches with NO options
 * (`src/adapter/AdapterManager.ts:119-120`):
 *
 *     this.readCache = new ReadCache();   // maxBytes → 64 MiB  (src/cache/ReadCache.ts:43)
 *     this.dirCache  = new DirCache();    // ttlMs    → 3000 ms (src/cache/DirCache.ts:27)
 *
 * so any vault with more than 64 MiB of *touched* content runs permanently in
 * eviction. The cache classes are unit-tested in isolation, where `put`/`peek`
 * are trivially correct; nothing exercises the ADAPTER's revalidation policy
 * against a real remote whose cache is being churned. Everything below runs
 * through the PATCHED `app.vault.adapter` in a live Obsidian window against the
 * docker sshd — the only place that policy is observable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT (SFTP suite, both tests) — mtime-only revalidation
 * ─────────────────────────────────────────────────────────────────────────────
 * `SftpDataAdapter.readBuffer()` — `src/adapter/SftpDataAdapter.ts:817-833` —
 * revalidates a cached read on **mtime EQUALITY ALONE**:
 *
 *     if (cached) {
 *       const s = await this.client.stat(remote);
 *       if (s.mtime === cached.mtime) {
 *         this.readCache.get(remote);   // ← serves the CACHED bytes
 *         return cached.data;
 *       }
 *
 * `s.size` is right there in the same stat — it is used two lines later
 * (`src/adapter/SftpDataAdapter.ts:825`) to size the transfer-tracker entry —
 * and is NEVER compared against `cached.data.byteLength`. Meanwhile SFTP mtime
 * has **1-second resolution**: `src/ssh/SftpClient.ts:664` does
 * `mtime: stats.mtime * 1000`; the sub-second part does not exist on the wire.
 *
 * Consequence: any remote edit landing in the SAME wall-clock second as the
 * cached copy's mtime is INVISIBLE to the adapter, which keeps serving the old
 * bytes indefinitely — even though the file's SIZE changed and stat said so.
 * In an editor that is silent data staleness: the user reads a version that no
 * longer exists on the server, and the next save writes it back over the real
 * one.
 *
 * Corroboration that the 1-second granularity is real and already known:
 * `e2e/reflect.spec.ts:143-145` must `waitForTimeout(1_100)` before its second
 * write, commented "sftp's mtime resolution is per-second". That sleep is a
 * test working around the product's blind spot.
 *
 * CORRECT BEHAVIOUR: a stat whose `size` differs from the cached buffer's
 * length MUST force a refetch, regardless of mtime. The fix belongs in
 * `SftpDataAdapter.readBuffer` (reuse the cached bytes only when mtime AND size
 * both match). It must NOT be "fixed" by weakening the assertions below.
 *
 * Why the deterministic defect test lives in the SFTP suite
 * --------------------------------------------------------
 * The defective code path is transport-independent — `SftpDataAdapter` is the
 * adapter for BOTH transports, only the injected `RemoteFsClient` differs. But
 * on RPC the daemon pushes `fs.changed` and
 * `FsChangeListener.handleNotification` calls `dataAdapter.invalidateRemotePath()`
 * (`src/vault/FsChangeListener.ts:204`), dropping the entry and MASKING the bug
 * — asynchronously, i.e. non-deterministically. On SFTP there is no
 * notification channel at all: `AdapterManager.patch` subscribes only
 * `if (this.conn.rpcConnection)` (`src/adapter/AdapterManager.ts:259-266`), and
 * no `WatchPoller` exists anywhere in `src/` (the name appears only in a
 * ReadCache comment). So on SFTP the stale entry is served forever. The SFTP
 * suite is therefore the DETERMINISTIC form of the defect. The RPC suite still
 * asserts the same user-visible correctness — today only the watch-invalidation
 * rescues it — so a regression in that mitigation also goes red.
 *
 * Predictions at time of writing:
 *   RPC suite  — all PASS.
 *   SFTP suite — BOTH tests FAIL. That is the defect, not a broken test.
 *
 * Proving eviction (never inferring it)
 * -------------------------------------
 * esbuild only minifies identifiers — `esbuild.config.mjs` sets `minify: prod`
 * and no `mangleProps` — so the live cache is reachable from the renderer:
 *
 *   app.plugins.plugins['remote-ssh'].adapterMgr.readCache.stats()
 *     → { entries, bytes, hits, misses, evictions }   (src/cache/ReadCache.ts:112-120)
 *   …readCache.has(remoteAbsPath)                     (src/cache/ReadCache.ts:65)
 *   …adapterMgr.dataAdapter.toRemote(vaultPath)       (src/adapter/SftpDataAdapter.ts:1023)
 *
 * Every eviction claim below is read off that probe. If the probe is missing
 * the spec HARD-FAILS with "cannot prove the cache was exceeded" rather than
 * quietly continuing with a weaker claim.
 *
 * A note on `stats().entries`: the cache also holds Obsidian's own small reads
 * (workspace.json, app.json, …), so a bare `entries < 9` would not mean what it
 * appears to. The blob-level residency check below is the honest form of that
 * claim: fewer than 9 of the 9 blobs remain resident, and blob0 — the LRU
 * victim — is provably gone.
 *
 * HARD-FAILS, never skips.
 */

// 9 × 8 MiB = 72 MiB of touched content against a 64 MiB budget: the working
// set cannot fit, so eviction is forced by construction, not by luck.
const BLOB_COUNT = 9;
const BLOB_BYTES = 8 * 1024 * 1024;

/** ReadCache default budget — `src/cache/ReadCache.ts:43`. */
const READ_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 67_108_864

/** DirCache default TTL — `src/cache/DirCache.ts:27`. */
const DIR_CACHE_TTL_MS = 3_000;

/**
 * Budget for "a remote directory change became visible through the adapter".
 * Deliberately tight: a regression to a long DirCache TTL, or a broken watch,
 * must go RED rather than merely be slow.
 */
const DIR_VISIBLE_MS = 5_000;

/** Same budget `reflect.spec.ts` uses for the remote→adapter propagation chain. */
const REFLECT_TIMEOUT_MS = 15_000;

const STAMP = Date.now().toString(36);
const blobRel = (i: number): string => `${STAMP}-blob${i}.bin`;
const BLOB_RELS = Array.from({ length: BLOB_COUNT }, (_, i) => blobRel(i));
const TARGET_REL = `${STAMP}-target.md`;
const PAYLOAD_REL = `${STAMP}-payload.bin`;
const LATE_REL = `${STAMP}-late.md`;
const SFTP_TARGET_REL = `${STAMP}-sftp-target.md`;

// 72 MiB of incompressible random bytes, generated once and reused by both the
// seeding and the expected-hash side of every assertion.
const BLOBS: Buffer[] = BLOB_RELS.map(() => crypto.randomBytes(BLOB_BYTES));
const BLOB_SHA: string[] = BLOBS.map((b) => sha256(b));

/** Every remote file this spec creates, for the afterAll sweep. */
const created = new Set<string>([
  ...BLOB_RELS, TARGET_REL, PAYLOAD_REL, LATE_REL, SFTP_TARGET_REL,
]);

let remote: RemoteVerifier;

// This spec pushes >72 MiB over loopback SSH inside single tests; the config
// default (120 s) is not enough. Applied at describe level AND per test/hook —
// `describe.configure({ timeout })` does not cover hook bodies on every
// Playwright version, and a hook that times out at 120 s while seeding 72 MiB
// would look like a product failure.
const LONG_TIMEOUT_MS = 300_000;
test.describe.configure({ timeout: LONG_TIMEOUT_MS });

test.beforeAll(async () => {
  test.setTimeout(LONG_TIMEOUT_MS);

  // HARD-FAIL, never skip: a down sshd is a broken harness and a broken connect
  // is a broken plugin. Both must be red, not green-by-skipping.
  await assertSshdReachable();

  remote = new RemoteVerifier();
  if (!(await remote.connect())) {
    throw new Error(
      'RemoteVerifier could not connect to the docker test sshd even though the ' +
      'port is open. This spec hard-fails rather than skipping.',
    );
  }

  for (let i = 0; i < BLOB_COUNT; i++) {
    await remote.writeBinaryFile(BLOB_RELS[i], BLOBS[i]);
  }
  await remote.writeFile(TARGET_REL, `# target ${STAMP}\n\ninitial\n`);
});

test.afterAll(async () => {
  if (!remote) return;
  await Promise.allSettled([...created].map((f) => remote.removeFile(f)));
  await remote.disconnect();
});

// ─── in-page probe shapes ─────────────────────────────────────────────────────
//
// Type-only declarations: erased at compile time, so referencing them inside a
// `page.evaluate` callback is safe (only *values* may not be captured).

interface ReadCacheStatsShape {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface ReadCacheProbe {
  stats?: () => ReadCacheStatsShape;
  has?: (remoteAbsPath: string) => boolean;
}

interface DataAdapterProbe {
  toRemote?: (vaultPath: string) => string;
}

interface PluginProbe {
  adapterMgr?: {
    readCache?: ReadCacheProbe | null;
    dataAdapter?: DataAdapterProbe | null;
  };
}

interface VaultAdapterProbe {
  read?: (p: string) => Promise<string>;
  readBinary?: (p: string) => Promise<ArrayBuffer>;
  writeBinary?: (p: string, data: ArrayBuffer) => Promise<void>;
  list?: (p: string) => Promise<{ files: string[]; folders: string[] }>;
}

interface WindowProbe {
  app?: {
    plugins?: { plugins?: Record<string, PluginProbe | undefined> };
    vault?: { adapter?: VaultAdapterProbe };
  };
}

type ProbeResult<T> = { ok: true; value: T } | { ok: false; why: string };

// ─── node-side helpers ────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Read `readCache.stats()` off the live plugin instance. Returns a discriminated
 * result rather than throwing, so the precondition test can report exactly WHICH
 * hop of the probe path is missing.
 */
async function probeReadCacheStats(page: Page): Promise<ProbeResult<ReadCacheStatsShape>> {
  return page.evaluate((): ProbeResult<ReadCacheStatsShape> => {
    const app = (window as unknown as WindowProbe).app;
    const plugin = app?.plugins?.plugins?.['remote-ssh'];
    if (!plugin) return { ok: false, why: "app.plugins.plugins['remote-ssh'] is undefined" };
    const mgr = plugin.adapterMgr;
    if (!mgr) {
      return {
        ok: false,
        why: `plugin.adapterMgr is undefined (plugin keys: ${Object.keys(plugin).join(',')})`,
      };
    }
    const rc = mgr.readCache;
    if (!rc) {
      return {
        ok: false,
        why:
          `adapterMgr.readCache is ${String(rc)} — the adapter is not patched ` +
          `(adapterMgr keys: ${Object.keys(mgr).join(',')})`,
      };
    }
    if (typeof rc.stats !== 'function') {
      return { ok: false, why: 'readCache.stats is not a function' };
    }
    return { ok: true, value: rc.stats() };
  });
}

/**
 * Same probe, but a missing probe is FATAL: without it no statement about
 * eviction can be made, and a spec that silently continued would be asserting
 * nothing.
 */
async function requireReadCacheStats(page: Page): Promise<ReadCacheStatsShape> {
  const r = await probeReadCacheStats(page);
  if (!r.ok) {
    throw new Error(
      'cannot prove the cache was exceeded: the ReadCache stats probe is ' +
      `unreachable — ${r.why}. Expected ` +
      "app.plugins.plugins['remote-ssh'].adapterMgr.readCache.stats().",
    );
  }
  return r.value;
}

/** Which of `rels` are STILL resident in the ReadCache, keyed by the real remote path. */
async function cachedFlags(page: Page, rels: string[]): Promise<boolean[]> {
  const r = await page.evaluate((paths): ProbeResult<boolean[]> => {
    const mgr = (window as unknown as WindowProbe).app?.plugins?.plugins?.['remote-ssh']?.adapterMgr;
    const rc = mgr?.readCache;
    const da = mgr?.dataAdapter;
    const has = rc?.has;
    const toRemote = da?.toRemote;
    if (!rc || !da || typeof has !== 'function' || typeof toRemote !== 'function') {
      return { ok: false, why: 'readCache.has / dataAdapter.toRemote unreachable' };
    }
    return { ok: true, value: paths.map((p) => has.call(rc, toRemote.call(da, p))) };
  }, rels);
  if (!r.ok) {
    throw new Error(`cannot prove the cache was exceeded: ${r.why}`);
  }
  return r.value;
}

/**
 * Read each path through the PATCHED adapter and hash the bytes IN-PAGE, so the
 * comparison is against exactly the buffer Obsidian hands a plugin — not a
 * re-fetch we performed ourselves.
 */
async function readBinaryInPage(
  page: Page,
  rels: string[],
): Promise<Array<{ path: string; sha256: string; byteLength: number }>> {
  return page.evaluate(async (paths) => {
    const adapter = (window as unknown as WindowProbe).app?.vault?.adapter;
    if (!adapter?.readBinary) {
      throw new Error('app.vault.adapter.readBinary is missing — the adapter is not patched');
    }
    const out: Array<{ path: string; sha256: string; byteLength: number }> = [];
    for (const p of paths) {
      const ab = await adapter.readBinary(p);
      const digest = await crypto.subtle.digest('SHA-256', ab);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      out.push({ path: p, sha256: hex, byteLength: ab.byteLength });
    }
    return out;
  }, rels);
}

/**
 * `adapter.read(path)` through the patched adapter. A thrown error comes back as
 * a `read-threw: …` string rather than propagating, so an `expect.poll` reports
 * its own message (and the offending value) instead of dying on a transient.
 */
async function adapterRead(page: Page, rel: string): Promise<string> {
  return page.evaluate(async (p) => {
    const adapter = (window as unknown as WindowProbe).app?.vault?.adapter;
    if (!adapter?.read) return 'read-threw: app.vault.adapter.read is missing';
    try {
      return await adapter.read(p);
    } catch (e) {
      return `read-threw: ${String(e)}`;
    }
  }, rel);
}

/** `adapter.list(dir).files` through the patched adapter. */
async function adapterListFiles(page: Page, dir: string): Promise<string[]> {
  return page.evaluate(async (d) => {
    const adapter = (window as unknown as WindowProbe).app?.vault?.adapter;
    if (!adapter?.list) {
      throw new Error('app.vault.adapter.list is missing — the adapter is not patched');
    }
    const listed = await adapter.list(d);
    return listed.files;
  }, dir);
}

/**
 * Connect a scaffolded vault and hand back a handle on the SHADOW window — the
 * only window whose `app.vault.adapter` is the patched one.
 */
async function connectShadow(scaffold: ScaffoldResult): Promise<ObsidianHandle> {
  let handle = await launchObsidian(scaffold.vaultPath);
  const shadowVaultPath = await connectAndWaitForShadowVault(handle.page, scaffold.vaultPath);
  await handle.cleanup();
  handle = await launchObsidian(shadowVaultPath);
  // launchObsidian only waits for the plugin to LOAD; the SSH connect + adapter
  // patch land later, at layout-ready. Every probe below assumes the PATCHED
  // adapter, so we must not proceed until the remote tree is in the model.
  await waitForShadowVaultLoaded(handle.page, logPathFor(shadowVaultPath), 30_000);
  return handle;
}

// ═════════════════════════════════════════════════════════════════════════════
// RPC transport — the default, and the transport under real cache pressure.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('ReadCache / DirCache under pressure (rpc transport)', () => {
  let obsidian: ObsidianHandle;
  let scaffold: ScaffoldResult;

  test.beforeAll(async () => {
    test.setTimeout(LONG_TIMEOUT_MS);
    scaffold = scaffoldTestVault(); // transport defaults to 'rpc'
    obsidian = await connectShadow(scaffold);
  });

  test.afterAll(async () => {
    await obsidian?.cleanup();
    scaffold?.cleanup();
  });

  test('precondition: the ReadCache stats probe is reachable', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    const probe = await probeReadCacheStats(obsidian.page);
    expect(
      probe.ok ? '' : probe.why,
      "cannot prove the cache was exceeded — app.plugins.plugins['remote-ssh']" +
      '.adapterMgr.readCache.stats() is unreachable from the renderer. Every ' +
      'eviction claim in this spec is read off that probe; without it the spec ' +
      'would be asserting nothing, so it hard-fails here rather than continuing.',
    ).toBe('');

    const stats = await requireReadCacheStats(obsidian.page);
    // The exact shape matters — the assertions below index these five fields.
    expect(Object.keys(stats).sort()).toEqual(['bytes', 'entries', 'evictions', 'hits', 'misses']);
    for (const [k, v] of Object.entries(stats)) {
      expect(typeof v, `readCache.stats().${k} must be a number`).toBe('number');
    }

    // `readCache.has()` + `dataAdapter.toRemote()` are how eviction of a SPECIFIC
    // file is proven below; fail here, not mid-assertion, if they are gone.
    const flags = await cachedFlags(obsidian.page, [TARGET_REL]);
    expect(flags).toHaveLength(1);

    const hasSubtle = await obsidian.page.evaluate(
      () => typeof crypto?.subtle?.digest === 'function',
    );
    expect(
      hasSubtle,
      'crypto.subtle.digest is unavailable in the Obsidian renderer — this spec ' +
      'hashes every payload in-page to compare against a Node-side SHA-256; ' +
      'without it the byte-identity claims could not be made at all.',
    ).toBe(true);
  });

  test('reading 72 MiB across 9 files provably exceeds the 64 MiB budget', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    const results = await readBinaryInPage(obsidian.page, BLOB_RELS);
    expect(results).toHaveLength(BLOB_COUNT);
    for (let i = 0; i < BLOB_COUNT; i++) {
      expect(results[i].byteLength, `${BLOB_RELS[i]} came back the wrong size`).toBe(BLOB_BYTES);
      expect(results[i].sha256, `${BLOB_RELS[i]} did not read back byte-identical`)
        .toBe(BLOB_SHA[i]);
    }

    const stats = await requireReadCacheStats(obsidian.page);

    expect(
      stats.evictions,
      `72 MiB of reads against a ${READ_CACHE_MAX_BYTES}-byte budget must have ` +
      'evicted something, but readCache.stats() reports 0 evictions ' +
      `(${JSON.stringify(stats)}). Either the budget is no longer the 64 MiB ` +
      'default (AdapterManager.ts:119 constructs `new ReadCache()` with no ' +
      'options) or the eviction path never ran — in either case the rest of this ' +
      'spec would not be testing cache pressure at all.',
    ).toBeGreaterThan(0);

    expect(
      stats.bytes,
      'the ReadCache is holding more bytes than its own budget — evictIfOverBudget ' +
      '(src/cache/ReadCache.ts:122) must bring `bytes` back to <= maxBytes after ' +
      'every put',
    ).toBeLessThanOrEqual(READ_CACHE_MAX_BYTES);

    // The honest form of "entries < 9": `stats().entries` also counts Obsidian's
    // own small reads, so blob-level residency is what actually proves the 72 MiB
    // working set did not fit.
    const resident = await cachedFlags(obsidian.page, BLOB_RELS);
    expect(
      resident.filter(Boolean).length,
      `all ${BLOB_COUNT} blobs (72 MiB) are still resident in a 64 MiB cache — the ` +
      'budget is not being enforced',
    ).toBeLessThan(BLOB_COUNT);
    expect(
      resident[0],
      'blob0 was read first and is therefore the least-recently-used blob; with ' +
      '72 MiB pushed through a 64 MiB budget it MUST have been an eviction victim',
    ).toBe(false);
  });

  test('a file evicted by LRU still reads back byte-identical', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    // Proven, not assumed: blob0 really is out of the cache, so this read has to
    // go back to the remote.
    const [before] = await cachedFlags(obsidian.page, [blobRel(0)]);
    expect(
      before,
      'blob0 is unexpectedly still cached — the previous test proved the 64 MiB ' +
      'budget was exceeded, so this read would not exercise the refetch path',
    ).toBe(false);

    const [got] = await readBinaryInPage(obsidian.page, [blobRel(0)]);
    const remoteStat = await remote.stat(blobRel(0));
    expect(remoteStat, `${blobRel(0)} vanished from the remote`).not.toBeNull();

    expect(
      got.byteLength,
      'the refetch after eviction returned an EMPTY buffer — an evicted entry must ' +
      'be re-fetched in full, not served as a zero-length miss',
    ).toBeGreaterThan(0);
    expect(
      got.byteLength,
      'the refetch after eviction returned a TRUNCATED buffer: the adapter produced ' +
      `${got.byteLength} bytes but the remote holds ${remoteStat!.size}`,
    ).toBe(remoteStat!.size);
    expect(
      got.sha256,
      'a file evicted by LRU did not read back byte-identical — eviction must be ' +
      'completely transparent to the reader',
    ).toBe(BLOB_SHA[0]);
  });

  test('a file evicted then MODIFIED remotely does not serve a stale copy', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    const first = `# target ${STAMP}\n\nversion-one\n`;
    await remote.writeFile(TARGET_REL, first);
    await expect
      .poll(() => adapterRead(obsidian.page, TARGET_REL), {
        message: 'the adapter never saw the seeded content of the target note',
        timeout: REFLECT_TIMEOUT_MS,
      })
      .toBe(first);

    // Push the 72 MiB working set through the cache again; the target note is now
    // the least-recently-used entry and must be evicted.
    await readBinaryInPage(obsidian.page, BLOB_RELS);
    const [stillCached] = await cachedFlags(obsidian.page, [TARGET_REL]);
    expect(
      stillCached,
      'could not evict the target note even after reading 72 MiB through a 64 MiB ' +
      'cache — the rest of this test would prove nothing',
    ).toBe(false);

    const second = `# target ${STAMP}\n\nversion-TWO-after-eviction\n`;
    await remote.writeFile(TARGET_REL, second);

    await expect
      .poll(() => adapterRead(obsidian.page, TARGET_REL), {
        message:
          'after eviction + a remote modification the adapter served a STALE copy. ' +
          'An evicted entry has no cached bytes to serve, so the read must have gone ' +
          'back to the remote and returned the new content.',
        timeout: REFLECT_TIMEOUT_MS,
      })
      .toBe(second);
  });

  test('a CACHED file modified remotely with an UNCHANGED mtime does not serve a stale copy', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    const before = `# target ${STAMP}\n\ncached-copy\n`;
    await remote.writeFile(TARGET_REL, before);
    await expect
      .poll(() => adapterRead(obsidian.page, TARGET_REL), {
        message: 'the adapter never saw the seeded content of the target note',
        timeout: REFLECT_TIMEOUT_MS,
      })
      .toBe(before);

    const [cached] = await cachedFlags(obsidian.page, [TARGET_REL]);
    expect(cached, 'the target note must be RESIDENT in the ReadCache for this test to mean anything')
      .toBe(true);

    const stat = await remote.stat(TARGET_REL);
    expect(stat, 'the target note vanished from the remote').not.toBeNull();
    const M = stat!.mtimeMs;

    // New bytes AND a new length: a `size` comparison — which `stat` hands the
    // adapter for free — would catch this even with the mtime frozen.
    const after = `# target ${STAMP}\n\nMODIFIED-SAME-MTIME-${'z'.repeat(400)}\n`;
    await remote.writeFile(TARGET_REL, after);
    // Force the mtime back to what the cache recorded — the deterministic
    // stand-in for "two edits inside one 1-second SFTP mtime tick".
    await remote.setMtime(TARGET_REL, Math.floor(M / 1000));

    const forced = await remote.stat(TARGET_REL);
    expect(forced, 'the target note vanished from the remote').not.toBeNull();
    expect(forced!.mtimeMs, 'harness: setMtime did not pin the mtime back to M').toBe(M);
    expect(forced!.size, 'harness: the remote size does not match the new content').toBe(
      Buffer.byteLength(after),
    );
    expect(
      forced!.size,
      'harness: the new content is the same LENGTH as the old one, so a size check ' +
      'could not detect it either — the fixture is wrong',
    ).not.toBe(Buffer.byteLength(before));

    await expect
      .poll(() => adapterRead(obsidian.page, TARGET_REL), {
        message:
          'STALE READ: the remote file has different bytes and a different SIZE but ' +
          'the same mtime, and the adapter served the cached copy. ' +
          'SftpDataAdapter.readBuffer (src/adapter/SftpDataAdapter.ts:817-833) ' +
          'compares ONLY `s.mtime === cached.mtime` and ignores `s.size`, even though ' +
          'the same stat carries it. On the RPC transport the daemon watch ' +
          '(src/vault/FsChangeListener.ts:204 → invalidateRemotePath) is the ONLY ' +
          'thing that drops the entry — if this assertion failed, that mitigation is ' +
          'gone and the mtime-only revalidation is now user-visible here too. The SFTP ' +
          'suite in this file shows the same defect with no mitigation at all. Fix the ' +
          'adapter (refetch when size differs); do NOT relax this assertion.',
        timeout: REFLECT_TIMEOUT_MS,
      })
      .toBe(after);
  });

  test('writes under cache pressure are not corrupted', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    // 3 MB of random bytes written through the PATCHED adapter's writeBinary —
    // the exact call an attachment / plugin write makes. `.bin` rather than `.md`
    // so Obsidian's metadata cache does not try to parse random bytes as markdown.
    const payload = crypto.randomBytes(3 * 1024 * 1024);
    const expectedSha = sha256(payload);
    const b64 = payload.toString('base64');

    const writeErr = await obsidian.page.evaluate(
      async ({ rel, data }) => {
        const adapter = (window as unknown as WindowProbe).app?.vault?.adapter;
        if (!adapter?.writeBinary) return 'app.vault.adapter.writeBinary is missing';
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        try {
          await adapter.writeBinary(rel, bytes.buffer);
          return null;
        } catch (e) {
          return String(e);
        }
      },
      { rel: PAYLOAD_REL, data: b64 },
    );
    expect(writeErr, 'writeBinary of the 3 MB payload failed').toBeNull();

    // Push the 72 MiB working set through the cache so the just-written entry —
    // now the least-recently-used one — is evicted. Without this the read-back
    // below would be served from the very buffer we wrote and would prove nothing
    // about what actually landed on the remote.
    await readBinaryInPage(obsidian.page, BLOB_RELS);
    const [stillCached] = await cachedFlags(obsidian.page, [PAYLOAD_REL]);
    expect(
      stillCached,
      'the just-written payload survived 72 MiB of reads through a 64 MiB cache — ' +
      'the verification read below would then hit the cache, not the remote',
    ).toBe(false);

    // Ground truth: what is ON THE REMOTE, read by a connection that has never
    // heard of the plugin's caches.
    const onRemote = await remote.readBinaryFile(PAYLOAD_REL);
    expect(onRemote, 'the 3 MB payload never reached the remote').not.toBeNull();
    expect(
      onRemote!.byteLength,
      'the payload on the remote is the wrong length — a write under cache pressure ' +
      'was truncated',
    ).toBe(payload.byteLength);
    expect(
      sha256(onRemote!),
      'the payload on the remote is NOT byte-identical to what was written — a write ' +
      'was corrupted while the cache was churning',
    ).toBe(expectedSha);

    // And the adapter's own read-back — now a genuine refetch — agrees.
    const [readBack] = await readBinaryInPage(obsidian.page, [PAYLOAD_REL]);
    expect(readBack.byteLength, 'adapter.readBinary of the payload returned the wrong length')
      .toBe(payload.byteLength);
    expect(
      readBack.sha256,
      'adapter.readBinary of the payload did not hash to the bytes that were written',
    ).toBe(expectedSha);
  });

  test('DirCache: a remote create is visible to adapter.list() within 5 s', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    // Populate the DirCache for the vault root.
    const initial = await adapterListFiles(obsidian.page, '');
    expect(
      initial.includes(TARGET_REL),
      'the target note seeded in beforeAll is not in adapter.list("") — the listing ' +
      'itself is broken, so nothing below would mean anything',
    ).toBe(true);
    expect(initial).not.toContain(LATE_REL);

    await remote.writeFile(LATE_REL, `# late ${STAMP}\n`);

    await expect
      .poll(async () => (await adapterListFiles(obsidian.page, '')).includes(LATE_REL), {
        message:
          'a file created on the remote was still not in adapter.list("") after ' +
          `${DIR_VISIBLE_MS} ms. The DirCache TTL is ${DIR_CACHE_TTL_MS} ms by default ` +
          '(src/cache/DirCache.ts:27, constructed with no options at ' +
          'src/adapter/AdapterManager.ts:120) and the RPC watch invalidates the entry ' +
          'outright (src/vault/FsChangeListener.ts:204) — so either the TTL regressed ' +
          'to something long or the watch-invalidation broke. Both are user-visible as ' +
          '"new files never show up".',
        timeout: DIR_VISIBLE_MS,
      })
      .toBe(true);
  });

  test('DirCache: a remote DELETE disappears from adapter.list()', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    // The create test left it there; make the starting state explicit anyway.
    await expect
      .poll(async () => (await adapterListFiles(obsidian.page, '')).includes(LATE_REL), {
        message: 'the late file is not listed, so its deletion cannot be observed',
        timeout: DIR_VISIBLE_MS,
      })
      .toBe(true);

    await remote.removeFile(LATE_REL);

    await expect
      .poll(async () => (await adapterListFiles(obsidian.page, '')).includes(LATE_REL), {
        message:
          'a file deleted on the remote was STILL listed by adapter.list("") after ' +
          `${DIR_VISIBLE_MS} ms — the DirCache is serving a directory listing that no ` +
          'longer exists. A user clicking that entry gets an ENOENT.',
        timeout: DIR_VISIBLE_MS,
      })
      .toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SFTP transport — no daemon watch channel, and therefore the only place the
// mtime-only revalidation defect is DETERMINISTICALLY observable.
//
// `AdapterManager.patch()` subscribes FsChangeListener only when an RPC tunnel
// exists (src/adapter/AdapterManager.ts:259-266), and no WatchPoller exists in
// src/, so on SFTP nothing ever invalidates a ReadCache entry from the outside.
// A cached entry whose mtime matches is served forever — whatever the remote
// says its SIZE is.
//
// BOTH tests below are PREDICTED TO FAIL against the current product. They are
// written at full strength on purpose: the defect lives in
// SftpDataAdapter.readBuffer (src/adapter/SftpDataAdapter.ts:817-833) and must
// be fixed THERE, not by weakening these assertions.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('stale reads on the SFTP transport (mtime-only revalidation)', () => {
  let obsidian: ObsidianHandle;
  let scaffold: ScaffoldResult;

  test.beforeAll(async () => {
    test.setTimeout(LONG_TIMEOUT_MS);
    scaffold = scaffoldTestVault({ transport: 'sftp' });
    obsidian = await connectShadow(scaffold);
  });

  test.afterAll(async () => {
    await obsidian?.cleanup();
    scaffold?.cleanup();
  });

  test('a CACHED file modified remotely with an UNCHANGED mtime does not serve a stale copy', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    const before = `# sftp target ${STAMP}\n\ncached-copy\n`;
    await remote.writeFile(SFTP_TARGET_REL, before);
    await expect
      .poll(() => adapterRead(obsidian.page, SFTP_TARGET_REL), {
        message: 'the adapter never saw the seeded content of the SFTP target note',
        timeout: REFLECT_TIMEOUT_MS,
      })
      .toBe(before);

    const [cached] = await cachedFlags(obsidian.page, [SFTP_TARGET_REL]);
    expect(cached, 'the note must be RESIDENT in the ReadCache for this test to mean anything')
      .toBe(true);

    const stat = await remote.stat(SFTP_TARGET_REL);
    expect(stat, 'the SFTP target note vanished from the remote').not.toBeNull();
    const M = stat!.mtimeMs;

    // New bytes AND a new length — the `size` the adapter already gets from stat
    // would catch this even with the mtime frozen.
    const after = `# sftp target ${STAMP}\n\nMODIFIED-SAME-MTIME-${'z'.repeat(600)}\n`;
    await remote.writeFile(SFTP_TARGET_REL, after);
    await remote.setMtime(SFTP_TARGET_REL, Math.floor(M / 1000));

    const forced = await remote.stat(SFTP_TARGET_REL);
    expect(forced, 'the SFTP target note vanished from the remote').not.toBeNull();
    expect(forced!.mtimeMs, 'harness: setMtime did not pin the mtime back to M').toBe(M);
    expect(forced!.size, 'harness: the remote size does not match the new content').toBe(
      Buffer.byteLength(after),
    );
    expect(
      forced!.size,
      'harness: the new content is the same LENGTH as the old one — the fixture is wrong',
    ).not.toBe(Buffer.byteLength(before));

    await expect
      .poll(() => adapterRead(obsidian.page, SFTP_TARGET_REL), {
        message:
          'STALE READ — THE DEFECT. The remote file has different bytes and a ' +
          'different SIZE, but the same mtime, and the adapter served the CACHED copy. ' +
          'SftpDataAdapter.readBuffer (src/adapter/SftpDataAdapter.ts:817-833) ' +
          'revalidates on `s.mtime === cached.mtime` ALONE: it never compares `s.size` ' +
          'against the cached buffer length, even though the very same stat returns ' +
          '`size` (it uses it two lines later, at :825, to size the transfer tracker). ' +
          'Because SFTP mtime is 1-second resolution (src/ssh/SftpClient.ts:664 — ' +
          '`mtime: stats.mtime * 1000`), any two edits inside one wall-clock second ' +
          'collapse onto the same mtime and the user silently keeps reading a version ' +
          'that no longer exists on the server — then saves it back over the real one. ' +
          'CORRECT BEHAVIOUR: a size mismatch MUST force a refetch. Fix it in ' +
          'SftpDataAdapter.readBuffer; do NOT weaken this assertion.',
        timeout: REFLECT_TIMEOUT_MS,
      })
      .toBe(after);
  });

  test('same-second remote edit on the SFTP transport (field-realistic repro)', async () => {
    test.setTimeout(LONG_TIMEOUT_MS);

    // The FIELD-REALISTIC form of the test above: no setMtime, no clock trickery —
    // just a read followed immediately by a remote edit, the way a second machine
    // (or a `git pull` on the server) actually behaves. The 1-second SFTP mtime
    // granularity does the rest.
    //
    // The test above is the DETERMINISTIC form. This one depends on the second edit
    // landing in the same wall-clock second as the cached copy's mtime, so that
    // condition is CONSTRUCTED rather than assumed: each attempt uses a fresh file,
    // and an attempt whose second edit crossed a second boundary is discarded and
    // retried (there the mtime moves and the adapter refetches for the RIGHT
    // reason — not the scenario under test). If no attempt ever lands inside one
    // second, the HARNESS is at fault and this test THROWS; it never degrades into
    // a vacuous pass.
    const ATTEMPTS = 8;
    let file: string | null = null;
    let expectedAfter = '';
    const crossings: number[] = [];

    for (let attempt = 0; attempt < ATTEMPTS && !file; attempt++) {
      const candidate = `${STAMP}-samesecond-${attempt}.md`;
      created.add(candidate);

      const first = `# same-second ${attempt}\n\nfirst\n`;
      await remote.writeFile(candidate, first);

      // Cache it. The cached entry's mtime is the second in which `first` landed.
      const got = await adapterRead(obsidian.page, candidate);
      expect(got, `attempt ${attempt}: the adapter did not read back the freshly written file`)
        .toBe(first);
      const cachedStat = await remote.stat(candidate);
      expect(cachedStat, `attempt ${attempt}: the candidate file vanished`).not.toBeNull();

      // Second edit, immediately, NO sleep — different content, different length.
      const second = `# same-second ${attempt}\n\nSECOND-EDIT-${'q'.repeat(300)}\n`;
      await remote.writeFile(candidate, second);
      const afterStat = await remote.stat(candidate);
      expect(afterStat, `attempt ${attempt}: the candidate file vanished`).not.toBeNull();

      if (afterStat!.mtimeMs === cachedStat!.mtimeMs) {
        file = candidate;
        expectedAfter = second;
      } else {
        crossings.push(attempt);
      }
    }

    if (!file) {
      throw new Error(
        'harness: could not land two edits inside one wall-clock second after ' +
        `${ATTEMPTS} attempts (every attempt crossed a second boundary: ` +
        `${crossings.join(',')}). This test HARD-FAILS rather than passing vacuously — ` +
        'the scenario it names was never actually created.',
      );
    }

    await expect
      .poll(() => adapterRead(obsidian.page, file!), {
        message:
          'STALE READ — THE DEFECT, in its field-realistic form. Two remote edits landed ' +
          'inside the same wall-clock second, so SFTP reported the SAME mtime for both ' +
          '(1-second resolution: src/ssh/SftpClient.ts:664). ' +
          'SftpDataAdapter.readBuffer (src/adapter/SftpDataAdapter.ts:817-833) ' +
          'revalidated on mtime EQUALITY ALONE and served the first version — even though ' +
          'the file SIZE changed and the stat it had just performed already said so. Same ' +
          'defect as the deterministic test above, reproduced with no clock manipulation ' +
          'at all: this is what a user editing from a second machine hits. CORRECT ' +
          'BEHAVIOUR: a size mismatch MUST force a refetch. Fix the adapter; do NOT weaken ' +
          'this assertion.',
        timeout: REFLECT_TIMEOUT_MS,
      })
      .toBe(expectedAfter);
  });
});
