import { test, expect } from '@playwright/test';
import {
  launchObsidian,
  driveConnectFlow,
  findShadowVaultPath,
  waitForShadowVaultLoaded,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';

/**
 * CAPABILITY PROBE — not a product test.
 *
 * We want to close the open half of #429 by taking Node's `fs` over in the
 * renderer and routing it to the remote daemon — instead of mirroring the note
 * tree to local disk (which abandons the virtual-vault design) or shipping a
 * FUSE dependency (which kills adoption).
 *
 * Patching `fs` is the easy part. The ENTIRE difficulty is one thing:
 *
 *     fs.readFileSync(p)  is SYNCHRONOUS, and the remote is 10-100 ms away.
 *
 * The WRITE side has an out: write locally, push in the background — the plugin
 * cannot tell. The READ side has none: a synchronous call must produce bytes
 * before it returns. That needs a real sync-over-async bridge, and whether one
 * EXISTS in Obsidian's renderer is an empirical question we have only been
 * guessing at.
 *
 * So stop guessing. This runs inside the real Obsidian and reports the facts.
 * It asserts only the things the approach would DEPEND on, so a red here means
 * "this design is not available", not "the product is broken".
 *
 * Probes:
 *   1. renderer Node surface        — require / child_process / worker_threads
 *   2. SharedArrayBuffer            — present? crossOriginIsolated?
 *   3. Atomics.wait on the MAIN thread — the ideal bridge. Chromium normally
 *      FORBIDS this on the main thread; Electron might not. THIS is the question.
 *   4. is require('fs') patchable   — shared module cache, writable properties
 *   5. spawnSync round-trip latency — the fallback bridge's real cost
 *   6. adapter read latency         — what a sync remote read would freeze the
 *                                     UI for, in milliseconds
 *
 * Read the JSON it prints in CI, then pick the design.
 */

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
let shadowVaultPath: string;

test.beforeAll(async () => {
  await assertSshdReachable();
  remote = new RemoteVerifier();
  if (!(await remote.connect())) throw new Error('RemoteVerifier could not connect to the test sshd');

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);
  await driveConnectFlow(obsidian.page);
  shadowVaultPath = await findShadowVaultPath(scaffold.vaultPath, 15_000);
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  await remote?.disconnect();
  scaffold?.cleanup();
});

test.describe('capability probe: can Node fs be routed to the remote daemon? (#429)', () => {
  test('PROBE — report the renderer capabilities that decide the design', async () => {
    const report = await obsidian.page.evaluate(async () => {
      const out: Record<string, unknown> = {};
      const req = (window as unknown as { require?: (m: string) => unknown }).require;

      // ── 1. renderer Node surface ──────────────────────────────────────────
      out.hasRequire = typeof req === 'function';
      if (typeof req !== 'function') return out;

      const tryReq = (m: string): unknown => { try { return req(m); } catch { return null; } };
      const procG = (globalThis as { process?: { versions?: Record<string, string>; execPath?: string } }).process;
      out.hasChildProcess = tryReq('child_process') !== null;
      out.hasWorkerThreads = tryReq('worker_threads') !== null;
      out.nodeVersion = procG?.versions?.node ?? null;
      out.electronVersion = procG?.versions?.electron ?? null;

      // ── 2. SharedArrayBuffer ──────────────────────────────────────────────
      out.hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
      out.crossOriginIsolated =
        (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? null;

      // ── 3. THE question: Atomics.wait on the renderer MAIN thread ─────────
      // Chromium forbids this on the main thread ("Atomics.wait cannot be
      // called in this context"). If Electron permits it, we get a real
      // sync-over-async bridge: no process spawn, no polling, microsecond
      // wake-up. If it throws, the ideal design is off the table.
      if (typeof SharedArrayBuffer !== 'undefined') {
        try {
          const sab = new SharedArrayBuffer(8);
          const ta = new Int32Array(sab);
          const t0 = performance.now();
          const r = Atomics.wait(ta, 0, 0, 5); // 'timed-out' means PERMITTED
          out.atomicsWaitMainThread = { allowed: true, result: r, ms: Math.round(performance.now() - t0) };
        } catch (e) {
          out.atomicsWaitMainThread = { allowed: false, error: String(e) };
        }
      } else {
        out.atomicsWaitMainThread = { allowed: false, error: 'no SharedArrayBuffer' };
      }

      // ── 4. is require('fs') patchable? ────────────────────────────────────
      // A plugin does `require('fs')`. If the module cache is shared and the
      // exported functions are writable, we can take them over.
      // Caveat we cannot fix and should record: a plugin that DESTRUCTURES —
      // `const { writeFileSync } = require('fs')` — captures the value and
      // bypasses any later patch.
      const fsA = tryReq('fs') as Record<string, unknown> | null;
      const fsB = tryReq('fs') as Record<string, unknown> | null;
      out.fsModuleCacheShared = fsA !== null && fsA === fsB;
      if (fsA) {
        const d = Object.getOwnPropertyDescriptor(fsA, 'writeFileSync');
        out.fsWriteFileSyncDescriptor = d
          ? { writable: d.writable ?? null, configurable: d.configurable ?? null }
          : null;
        try {
          const orig = fsA.writeFileSync;
          let sawPatched = false;
          fsA.writeFileSync = () => { sawPatched = true; };
          // Call it through a FRESH require, the way a plugin would.
          (tryReq('fs') as Record<string, () => void>).writeFileSync();
          fsA.writeFileSync = orig; // restore immediately — no disk I/O happened
          out.fsPatchTakesEffect = sawPatched;
        } catch (e) {
          out.fsPatchTakesEffect = `threw: ${String(e)}`;
        }
      }

      // ── 5. spawnSync round-trip cost (the fallback bridge) ────────────────
      const cp = tryReq('child_process') as {
        spawnSync?: (c: string, a: string[], o?: unknown) => unknown;
      } | null;
      if (cp?.spawnSync && procG?.execPath) {
        const samples: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          try { cp.spawnSync(procG.execPath, ['-e', '0'], { timeout: 10_000 }); } catch { /* still timed */ }
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        out.spawnSyncMs = { samples: samples.map((s) => Math.round(s)), medianMs: Math.round(samples[2]) };
      } else {
        out.spawnSyncMs = null;
      }

      // ── 6. what a sync remote read would cost the UI ──────────────────────
      const app = (window as unknown as {
        app?: { vault?: { adapter?: { read?: (p: string) => Promise<string> } } };
      }).app;
      const adapter = app?.vault?.adapter;
      if (adapter?.read) {
        const samples: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          try { await adapter.read('remote_demo1.md'); } catch { /* still timed */ }
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        out.adapterReadMs = {
          samples: samples.map((s) => Math.round(s)),
          medianMs: Math.round(samples[2]),
          note: 'sample 1 is a cold remote fetch; later ones are likely cache hits',
        };
      }

      // ── 7. synchronous XHR against the ResourceBridge ─────────────────────
      // This is the vehicle the shipped `getFullPath` / `getFilePath`
      // materialisation actually uses, so it is the one probe whose answer is
      // already load-bearing. Chromium deprecates main-thread synchronous XHR
      // but still permits it; if Obsidian's build does not, on-demand
      // materialisation silently degrades to "return the path, no file" — and
      // we want to learn that from CI, not from a user.
      //
      // The URL carries the bridge's session token, so only its scheme is
      // reported; the token must never reach a CI log.
      const bridgeUrl = (window as unknown as {
        app?: { vault?: { adapter?: { getResourcePath?: (p: string) => string } } };
      }).app?.vault?.adapter?.getResourcePath?.('remote_demo1.md') ?? null;
      out.bridgeUrlScheme = bridgeUrl === null ? null : bridgeUrl.slice(0, bridgeUrl.indexOf(':'));
      if (bridgeUrl && bridgeUrl.startsWith('http')) {
        try {
          const t0 = performance.now();
          const xhr = new XMLHttpRequest();
          xhr.open('GET', bridgeUrl, false);          // false = synchronous
          xhr.overrideMimeType('text/plain; charset=x-user-defined');
          xhr.send();
          out.syncXhr = {
            allowed: true,
            status: xhr.status,
            bytes: xhr.responseText.length,
            ms: Math.round(performance.now() - t0),
          };
        } catch (e) {
          out.syncXhr = { allowed: false, error: String(e) };
        }
      } else {
        out.syncXhr = { allowed: false, error: `no http bridge URL (got ${String(bridgeUrl)})` };
      }

      return out;
    });

    // eslint-disable-next-line no-console
    console.log(
      '\n===== FS SYNC-BRIDGE CAPABILITY REPORT =====\n' +
      JSON.stringify(report, null, 2) +
      '\n===========================================\n',
    );

    // The preconditions the whole approach rests on. A red here is a FINDING
    // ("this design is not available in Obsidian's renderer"), not a bug.
    expect(report.hasRequire, 'the renderer must expose require() to patch fs at all').toBe(true);
    expect(
      report.fsModuleCacheShared,
      "require('fs') must return the SAME module object a plugin sees, or a patch is invisible to it",
    ).toBe(true);
    expect(
      report.fsPatchTakesEffect,
      'patching the fs module object must be observable through a fresh require()',
    ).toBe(true);
    expect(report.hasChildProcess, 'child_process is the fallback sync bridge').toBe(true);
    // Already shipped and depended upon: `SftpDataAdapter.getFullPath` uses a
    // synchronous XHR to the bridge to materialise the file it is asked about.
    // If this is red, that feature is inert — every returned path points at
    // nothing again — and `syncHttpGet.ts` needs a different vehicle.
    expect(
      (report.syncXhr as { allowed?: boolean } | undefined)?.allowed,
      'synchronous XHR to the ResourceBridge is the vehicle on-demand ' +
      'materialisation runs on; without it getFullPath cannot resolve',
    ).toBe(true);
  });
});
