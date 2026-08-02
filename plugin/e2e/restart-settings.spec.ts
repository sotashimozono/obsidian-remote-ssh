import { test, expect } from '@playwright/test';
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
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #342 / #429 — a third-party plugin's settings must survive an Obsidian
 * RESTART. This is the only spec that actually quits Obsidian and relaunches
 * it on the SAME vault, which is the entire failure surface of those issues.
 *
 * Why nothing else catches this
 * -----------------------------
 * The bug is an ORDERING bug. Obsidian loads community plugins during startup
 * and each `onload()` calls `Plugin.loadData()` — reading
 * `.obsidian/plugins/<id>/data.json` off the LOCAL shadow disk — BEFORE
 * remote-ssh has connected over SSH and patched the vault adapter. Nothing
 * used to write that local copy (`saveData()` went through the patched adapter
 * straight to the remote), so every restart booted plugins on DEFAULTS, which
 * they then saved back, overwriting the good settings on the remote too.
 *
 * No unit test can see this: it needs a real Obsidian process to die and come
 * back. `tests/integration/restart-roundtrip.e2e.test.ts` is NOT that test —
 * despite the name it is a vitest that never starts Obsidian; it calls
 * `ShadowVaultBootstrap` against a tmpdir and asserts the bootstrap's own
 * output. It proves the pull works; it does not prove Obsidian READS it.
 *
 * What this spec does
 * -------------------
 *   1. connect → land in the shadow vault window
 *   2. write a plugin's `data.json` through the PATCHED adapter — byte-for-byte
 *      what `Plugin.saveData()` does
 *   3. assert the remote stored it PER-DEVICE (under `.obsidian/user/<id>/`)
 *      and NOT at the shared identity path — two machines must not collide
 *   4. assert the LOCAL shadow disk got it too (the write-through)
 *   5. QUIT Obsidian, RELAUNCH on the SAME shadow vault
 *   6. assert the settings are still on local disk — i.e. what `loadData()`
 *      reads at the next startup is the real settings, not defaults
 *
 * Against the pre-1.1.7 build, step 4 fails outright: the local file is never
 * created, because the write only ever went to the remote.
 *
 * HARD-FAILS, never skips.
 */

const STAMP = Date.now().toString(36);

/** A stand-in for any community plugin (Claudian, TaskNotes, …). */
const PROBE_PLUGIN_ID = 'e2e-settings-probe';
const PROBE_DATA_REL = `.obsidian/plugins/${PROBE_PLUGIN_ID}/data.json`;

/**
 * What the "plugin" persists. Non-default on purpose: booting on defaults IS
 * the symptom, so the payload has to be something defaults could never be.
 */
const PROBE_SETTINGS = {
  probe: STAMP,
  enabled: true,
  nested: { n: 42 },
};

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
let shadowVaultPath: string;

test.beforeAll(async () => {
  await assertSshdReachable();

  remote = new RemoteVerifier();
  if (!(await remote.connect())) {
    throw new Error(
      'RemoteVerifier could not connect to the docker test sshd even though ' +
      'the port is open. This spec hard-fails rather than skipping.',
    );
  }

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // Use the building blocks rather than `connectAndOpenShadow` so we keep hold
  // of the shadow vault PATH — needed both to relaunch on the same vault and
  // to read the on-disk copy directly.
  shadowVaultPath = await connectAndWaitForShadowVault(obsidian.page, scaffold.vaultPath);
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);

  // MUST wait for the shadow window to finish connecting before touching the
  // adapter. `launchObsidian` only waits for the plugin to LOAD; the SSH
  // connect + adapter patch land later, at layout-ready. Writing before that
  // hits the stock FileSystemAdapter and dies with a local-disk ENOENT (it
  // does not mkdir -p) — which is itself a neat demonstration of the very
  // window #342/#429 lives in: at startup the adapter is NOT ours yet.
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  if (remote) {
    // The per-device copy lives under a client-id dir discovered at runtime.
    for (const dir of await remote.listDir('.obsidian/user')) {
      await remote
        .removeFile(`.obsidian/user/${dir}/plugins/${PROBE_PLUGIN_ID}/data.json`)
        .catch(() => {});
    }
    await remote.removeFile(PROBE_DATA_REL).catch(() => {});
    await remote.disconnect();
  }
  scaffold?.cleanup();
});

/**
 * Locate the probe's per-device `data.json` on the remote by scanning the
 * `.obsidian/user/<clientId>/` subtrees. Deliberately DISCOVERED rather than
 * computed from `os.hostname()`, so the test pins BEHAVIOUR ("it landed in
 * some per-device subtree") instead of re-implementing `sanitizeClientId`.
 */
async function readPerDeviceProbe(): Promise<{ clientId: string; body: string } | null> {
  for (const clientId of await remote.listDir('.obsidian/user')) {
    const body = await remote.readFile(
      `.obsidian/user/${clientId}/plugins/${PROBE_PLUGIN_ID}/data.json`,
    );
    if (body !== null) return { clientId, body };
  }
  return null;
}

/** The local shadow-disk path Obsidian's `loadData()` reads at startup. */
function localProbePath(): string {
  return path.join(shadowVaultPath, ...PROBE_DATA_REL.split('/'));
}

test.describe('plugin settings survive an Obsidian restart (#342 / #429)', () => {
  test('saveData → quit → relaunch: settings survive, and the remote copy is per-device', async () => {
    // ── 1. Persist settings exactly the way Plugin.saveData() does ─────────
    // saveData() is literally `adapter.write('.obsidian/plugins/<id>/data.json', json)`.
    // Going through the PATCHED adapter is the whole point: that is the path
    // that used to reach only the remote, leaving the local disk cold.
    const writeErr = await obsidian.page.evaluate(
      async ({ rel, settings }) => {
        const app = (window as unknown as {
          app?: { vault?: { adapter?: { write?: (p: string, d: string) => Promise<void> } } };
        }).app;
        const adapter = app?.vault?.adapter;
        if (!adapter?.write) return 'no adapter on app.vault.adapter';
        try {
          await adapter.write(rel, JSON.stringify(settings));
          return null;
        } catch (e) {
          return String(e);
        }
      },
      { rel: PROBE_DATA_REL, settings: PROBE_SETTINGS },
    );
    expect(writeErr, 'the saveData()-equivalent write failed').toBeNull();

    // ── 2. The remote stored it PER-DEVICE, not at the shared path ─────────
    // `saveData()` fires on EVERY settings change, so a shared remote path is
    // a perpetual write-conflict between two machines.
    await expect
      .poll(async () => (await readPerDeviceProbe()) !== null, {
        message: 'probe data.json never appeared under .obsidian/user/<clientId>/ on the remote',
        timeout: 15_000,
      })
      .toBe(true);

    const perDevice = await readPerDeviceProbe();
    expect(perDevice).not.toBeNull();
    expect(JSON.parse(perDevice!.body)).toEqual(PROBE_SETTINGS);

    expect(
      await remote.exists(PROBE_DATA_REL),
      'plugin settings must NOT be written to the shared identity path — that ' +
      'is the cross-device write-conflict this design exists to make impossible',
    ).toBe(false);

    // ── 3. The write-through put it on LOCAL disk ─────────────────────────
    // This is the assertion that fails on every build before 1.1.7: the local
    // copy simply never existed, which is why the next startup read defaults.
    await expect
      .poll(() => fs.existsSync(localProbePath()), {
        message:
          'local shadow-disk copy of data.json was never written. Obsidian reads ' +
          'THIS file at startup, before the plugin connects — without it the ' +
          'plugin boots on defaults and overwrites the remote (#342 / #429).',
        timeout: 10_000,
      })
      .toBe(true);
    expect(JSON.parse(fs.readFileSync(localProbePath(), 'utf8'))).toEqual(PROBE_SETTINGS);

    // ── 4. QUIT and RELAUNCH on the SAME vault ────────────────────────────
    await obsidian.cleanup();
    obsidian = await launchObsidian(shadowVaultPath);

    // ── 5. What a startup loadData() would see is the REAL settings ────────
    // Asserted BEFORE waiting for the connect, deliberately. `launchObsidian`
    // returns once the plugin has LOADED but before the SSH connect + adapter
    // patch — i.e. we are standing exactly in the pre-connect window where
    // Obsidian calls each plugin's `loadData()`. Whatever is on local disk
    // right now IS what a third-party plugin gets handed. It must be the real
    // settings, not nothing.
    expect(
      fs.existsSync(localProbePath()),
      'after restart the local data.json is gone — in this exact window ' +
      'loadData() would return defaults, and the plugin would then save those ' +
      'defaults over the real settings on the remote (#342 / #429)',
    ).toBe(true);

    expect(
      JSON.parse(fs.readFileSync(localProbePath(), 'utf8')),
      'settings did not survive the restart',
    ).toEqual(PROBE_SETTINGS);

    // ── 6. Let the session fully reconnect, then check for the data loss ───
    // This is where the old bug did its damage: the plugin (booted on
    // defaults) saves them, the adapter gets patched, and the defaults land on
    // the remote on top of the real settings. Give it the chance to happen.
    await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

    const after = await readPerDeviceProbe();
    expect(after, 'per-device settings vanished from the remote after restart').not.toBeNull();
    expect(
      JSON.parse(after!.body),
      'the remote copy was overwritten during the restart — this is the ' +
      'data-loss half of #429 (plugin boots on defaults, then saves them back ' +
      'over the real settings on the remote)',
    ).toEqual(PROBE_SETTINGS);
  });
});
