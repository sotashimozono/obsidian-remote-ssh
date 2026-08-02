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
import { makeFakePlugin, seedPluginOnRemote } from './helpers/remote-fixtures';
import {
  COMMUNITY_PLUGINS_REL,
  captureCommunityPlugins,
  preCleanRemoteFixtures,
  resetRemoteFixtures,
  type CommunityPluginsSnapshot,
  type FixtureFootprint,
} from './helpers/remote-reset';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #429b — third-party plugin CODE crossing the device boundary.
 *
 * `restart-settings.spec.ts` covers a plugin's *settings* (`data.json`, which
 * is deliberately PER-DEVICE, under `.obsidian/user/<clientId>/`). This spec
 * covers the other half, and the one that decides whether a plugin exists at
 * all on a second machine: its CODE.
 *
 * The contract (product side)
 * ---------------------------
 * `ShadowVaultBootstrap.PLUGIN_BINARY_FILES = ['manifest.json','main.js','styles.css']`
 * (`src/shadow/ShadowVaultBootstrap.ts:733`). `data.json` is NOT in that list,
 * on purpose: plugin code is IDENTITY-shared (every device runs the same
 * plugin), plugin settings are DEVICE-scoped. Leaking `data.json` into the
 * code round-trip would recreate exactly the cross-device settings collision
 * that `.obsidian/user/<clientId>/` exists to prevent.
 *
 * The connect-time sequence (`src/main.ts:632-670`) is:
 *
 *   1. `pullCommunityPlugins` / `pushCommunityPlugins` — round-trip the
 *      *enabled list* (`.obsidian/community-plugins.json`), with `remote-ssh`
 *      force-unioned in so a remote list that omits it can never disable the
 *      very plugin doing the sync.
 *   2. `installMissingShadowPlugins` — marketplace fetch for ids the list now
 *      names but whose binaries aren't staged.
 *   3. `pullPluginBinaries` / `pushPluginBinaries` — the CODE round-trip, for
 *      the plugins the marketplace cannot serve (BRAT / sideloaded), and as a
 *      fallback when a marketplace fetch failed.
 *
 * Convergence is VERSION-ORDERED, not last-writer-wins
 * ----------------------------------------------------
 * `pullPluginBinaries` pulls only when the plugin is absent locally or the
 * remote manifest `version` is STRICTLY NEWER (`ShadowVaultBootstrap.ts:762`);
 * `pushPluginBinaries` pushes only when the remote lacks it or the local
 * version is strictly newer (`:806`). This is load-bearing: a "content
 * differs" gate would let a laggard machine downgrade a plugin the rest of the
 * fleet already upgraded, and the two sides would ping-pong on every connect,
 * forever. It also means a test that seeds files without thinking about
 * `version` silently exercises nothing — both sides skip. Every fixture here
 * therefore pins its version explicitly, and the probe's `onload()` body is
 * overridden to STAMP THE VERSION into `window.__E2E_PROBE__` (the default body
 * from `makeFakePlugin` records only `{ id, loaded }`).
 *
 * Test 6 is EXPECTED TO FAIL — it encodes a real defect
 * -----------------------------------------------------
 * `pushCommunityPlugins` (`src/shadow/ShadowVaultBootstrap.ts:698-702`)
 * computes a monotonic UNION of remote+local and then "No-ops when the remote
 * already equals the union". The list can therefore only ever GROW. A user who
 * uninstalls a plugin on one machine can never propagate that removal: the push
 * will not shrink the remote list, and on the very next connect
 * `pullCommunityPlugins` (`:652`) merges the remote list back in and RESURRECTS
 * the plugin locally. The union is the right anti-clobber default for a stale
 * local list, but it is not removal semantics; the fix belongs in the PRODUCT
 * (a tombstone / explicit-removal channel that distinguishes "this device never
 * had it" from "this device deleted it"), NOT in weakening this test. Test 6
 * asserts the user-facing behaviour — an uninstall sticks — and is left red.
 *
 * …which is exactly WHY the fixtures must be force-purged in `afterAll`
 * ---------------------------------------------------------------------
 * The defect test 6 pins is the reason this spec cannot rely on the product to
 * tidy up after it. The remote enabled list is MONOTONIC: once `e2e-probe` /
 * `e2e-probe2` are in it, nothing this spec does — including deleting them
 * locally, which is literally what test 6 does — will take them out again. And
 * the docker test vault is SHARED and PERSISTS across specs within a run, so a
 * fixture left enabled there is pulled into the shadow vault of every LATER
 * spec at connect (`src/main.ts:632-670`), staged, and loaded. That is not
 * hypothetical: it is what turned the previously-passing
 * `sync.spec.ts › create — new note appears on remote` red.
 *
 * So `afterAll` restores the remote's `community-plugins.json` to its captured
 * bytes and rmrf's every fixture plugin dir (shared AND per-device),
 * unconditionally, wrapped step-by-step so a red test still cleans up. That
 * cleanup is the HARNESS's job, not the product's — it must not, and does not,
 * touch test 6's assertions. If anything, having to hand-revert the remote is
 * itself evidence of the defect's blast radius: a real user has no `afterAll`.
 *
 * State is CHAINED across the tests in this file (each builds on the shadow
 * vault the previous one left behind), hence `mode: 'serial'` and the generous
 * per-test timeout: several of them quit and relaunch Obsidian.
 *
 * HARD-FAILS, never skips.
 */

/** Pulled from the remote (device-B direction). Seeded BEFORE the first connect. */
const PROBE_ID = 'e2e-probe';
/** Pushed from the shadow disk (device-A direction). Written AFTER the first connect. */
const PROBE2_ID = 'e2e-probe2';

const PROBE_V1 = '1.0.0';
const PROBE_V2 = '2.0.0';
const PROBE2_V = '2.0.0';
const PROBE2_V_BUMPED = '2.0.1';

const SELF_ID = 'remote-ssh';

const BINARY_FILES = ['manifest.json', 'main.js', 'styles.css'] as const;

/** Everything this spec puts on the SHARED remote — and therefore owes back. */
const FOOTPRINT: FixtureFootprint = { pluginIds: [PROBE_ID, PROBE2_ID] };

/**
 * A probe whose `onload()` records its VERSION as well as the fact that it ran.
 * The version matters: it is the only way to prove which *copy* of the code
 * Obsidian actually executed after a version-ordered convergence.
 *
 * NOTE the constraint on WHERE these fixtures may be seeded: never into the
 * SOURCE scaffold vault. `ShadowVaultBootstrap` snapshots the source vault's
 * community plugins into `settings.pendingPluginSuggestions`, and the shadow
 * window then opens a `PendingPluginsModal` that swallows Ctrl+P, hanging every
 * later palette interaction. Fixtures go on the REMOTE, or onto the shadow disk
 * AFTER the connect — never into the scaffold.
 */
function probeFiles(id: string, version: string): Record<string, string> {
  const files = makeFakePlugin({
    id,
    version,
    onloadBody:
      `window.__E2E_PROBE__ = { id: ${JSON.stringify(id)}, ` +
      `version: ${JSON.stringify(version)}, loaded: true };`,
  });
  return { ...files };
}

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
/**
 * Captured ONCE. `findShadowVaultPath` picks the most recently registered vault
 * out of the user-global `obsidian.json`, so re-resolving it after a later
 * connect could drift onto a different vault — every relaunch in this file
 * reuses this exact path.
 */
let shadowVaultPath: string;
/**
 * The remote's `community-plugins.json` as it was BEFORE this spec seeded
 * anything (null = it did not exist). Captured after the pre-clean, so it is a
 * clean baseline, and put back byte-for-byte in `afterAll`.
 */
let communityPluginsSnapshot: CommunityPluginsSnapshot = { raw: null };

/** A path inside the shadow vault's `.obsidian` config dir. */
function localPath(...segments: string[]): string {
  return path.join(shadowVaultPath, '.obsidian', ...segments);
}

function readLocalList(): string[] {
  return JSON.parse(fs.readFileSync(localPath('community-plugins.json'), 'utf8')) as string[];
}

function writeLocalList(ids: string[]): void {
  fs.writeFileSync(localPath('community-plugins.json'), `${JSON.stringify(ids)}\n`, 'utf8');
}

async function readRemoteList(): Promise<string[]> {
  const body = await remote.readFile(COMMUNITY_PLUGINS_REL);
  if (body === null) throw new Error('remote community-plugins.json is missing');
  return JSON.parse(body) as string[];
}

/** Write a plugin's files onto the LOCAL shadow disk (the device-A direction). */
function writeLocalPlugin(id: string, files: Record<string, string>): void {
  const dir = localPath('plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
}

/** Quit Obsidian and relaunch it on the SAME shadow vault, fully reconnected. */
async function relaunchShadow(): Promise<void> {
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
}

// The tests below CHAIN: each one leaves the shadow vault in the state the next
// one starts from. Serial keeps them in one worker, in order.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await assertSshdReachable();

  remote = new RemoteVerifier();
  if (!(await remote.connect())) {
    throw new Error(
      'RemoteVerifier could not connect to the docker test sshd even though the port ' +
      'is open. This spec hard-fails rather than skipping.',
    );
  }

  // DEFENSIVE PRE-CLEAN. A previous run that crashed (or was killed) leaves its
  // fixture plugins on the shared docker vault — in `.obsidian/plugins/`, in the
  // per-device `.obsidian/user/<clientId>/plugins/`, and named in the remote
  // enabled list, which the monotonic union can never have removed. Inheriting
  // any of that would make the version-ordering assertions below meaningless.
  await preCleanRemoteFixtures(remote, FOOTPRINT);

  // The clean baseline `afterAll` restores byte-for-byte. Captured AFTER the
  // pre-clean, so a leftover fixture id can never be baked into the "original".
  communityPluginsSnapshot = await captureCommunityPlugins(remote);

  // ── DEVICE B: the plugin exists ONLY on the remote, before we ever connect ──
  // The list is written to EXACTLY `[PROBE_ID]` (not merged): test 1 asserts the
  // connect MERGES rather than copies it — that `remote-ssh` survives a remote
  // list that omits it — and a merged seed would not exercise that at all.
  await remote.removeFile(COMMUNITY_PLUGINS_REL);
  await seedPluginOnRemote(remote, PROBE_ID, probeFiles(PROBE_ID, PROBE_V1));
  await remote.writeFile(COMMUNITY_PLUGINS_REL, `${JSON.stringify([PROBE_ID])}\n`);

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // Building blocks rather than `connectAndOpenShadow`, to KEEP the shadow vault
  // path: every relaunch below reuses it, and the on-disk assertions read
  // straight out of it.
  shadowVaultPath = await connectAndWaitForShadowVault(obsidian.page, scaffold.vaultPath);
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);

  // `launchObsidian` only waits for the plugin to LOAD; the SSH connect (and
  // with it the whole plugin round-trip) lands later, at layout-ready.
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
});

test.afterAll(async () => {
  // Runs even when a test FAILED — and one of them (test 6) is expected to. The
  // product cannot revert this itself: the enabled list only ever grows, so a
  // fixture left there is loaded by every later spec's shadow vault at connect.
  // Each step is guarded inside `resetRemoteFixtures`, so a failure in one
  // cannot skip the others.
  await obsidian?.cleanup().catch(() => {});
  if (remote) {
    await resetRemoteFixtures(remote, FOOTPRINT, communityPluginsSnapshot);
    await remote.disconnect();
  }
  scaffold?.cleanup();
});

test.beforeEach(() => {
  // Several of these tests quit and relaunch Obsidian more than once; the 120 s
  // file default has no headroom for that.
  test.setTimeout(240_000);
});

test.describe('third-party plugin CODE round-trips across the device boundary (#429b)', () => {
  test('pull: a plugin that exists only on the remote is staged onto this device', async () => {
    const seeded = probeFiles(PROBE_ID, PROBE_V1);

    // The connect in `beforeAll` ran pullCommunityPlugins → installer →
    // pullPluginBinaries. `e2e-probe` is not on the marketplace, so ONLY the
    // binary pull can have put it here.
    for (const file of BINARY_FILES) {
      const localFile = localPath('plugins', PROBE_ID, file);
      await expect
        .poll(() => fs.existsSync(localFile), {
          message:
            `${file} was never staged onto the shadow disk for '${PROBE_ID}'. A plugin ` +
            'installed on another machine (BRAT / sideloaded) therefore does not exist on ' +
            'this one: the enabled list names it, but there is no code to load.',
          timeout: 20_000,
        })
        .toBe(true);

      expect(
        fs.readFileSync(localFile, 'utf8'),
        `${file} was staged but its bytes differ from what the remote holds`,
      ).toBe(seeded[file]);
    }

    // The enabled list must be the MERGE, not a verbatim copy: the remote list is
    // `["e2e-probe"]`, and writing that verbatim would drop `remote-ssh` — the
    // sync plugin would switch ITSELF off on connect.
    const localList = readLocalList();
    expect(localList, `the pulled plugin '${PROBE_ID}' is missing from the local enabled list`)
      .toContain(PROBE_ID);
    expect(
      localList,
      'the merge dropped remote-ssh from the enabled list — the next vault open would start ' +
      'with the sync plugin disabled, and nothing would ever reconnect',
    ).toContain(SELF_ID);
  });

  test('a pulled plugin actually LOADS on the next start of the shadow vault', async () => {
    // Obsidian scans `.obsidian/plugins/` at STARTUP, so code staged during the
    // previous connect can only load on the next open. Without this, test 1
    // proves nothing a user can feel: bytes on disk that never execute are a
    // silent non-fix.
    await relaunchShadow();

    const probe = await obsidian.page.evaluate((id: string) => {
      const app = (window as unknown as {
        app?: { plugins?: { plugins?: Record<string, unknown> } };
      }).app;
      const sentinel = (window as unknown as {
        __E2E_PROBE__?: { id?: string; version?: string; loaded?: boolean };
      }).__E2E_PROBE__;
      return {
        registered: Boolean(app?.plugins?.plugins?.[id]),
        sentinel: sentinel ?? null,
        ids: Object.keys(app?.plugins?.plugins ?? {}),
      };
    }, PROBE_ID);

    expect(
      probe.registered,
      `Obsidian did not register '${PROBE_ID}' at startup (loaded: ` +
      `${probe.ids.join(', ') || 'none'}). The code was staged but never ran — from the ` +
      'user\'s point of view the plugin is still not installed on this device.',
    ).toBe(true);

    expect(
      probe.sentinel?.loaded,
      `'${PROBE_ID}' is registered but its onload() sentinel never fired`,
    ).toBe(true);
    expect(probe.sentinel?.version, 'the copy Obsidian ran is not the version we staged')
      .toBe(PROBE_V1);
  });

  test('push: a plugin present only on THIS device reaches the remote', async () => {
    const files = probeFiles(PROBE2_ID, PROBE2_V);

    // Install it the way a sideload does: drop the code into the shadow vault's
    // plugins dir and enable it in the list, with Obsidian NOT running.
    await obsidian.cleanup();
    writeLocalPlugin(PROBE2_ID, files);
    writeLocalList([...readLocalList(), PROBE2_ID]);

    obsidian = await launchObsidian(shadowVaultPath);
    await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

    for (const file of BINARY_FILES) {
      const rel = `.obsidian/plugins/${PROBE2_ID}/${file}`;
      await expect
        .poll(() => remote.exists(rel), {
          message:
            `${rel} never reached the remote. The remote vault is the canonical store every ` +
            'other machine pulls from — a plugin that only ever lives on the device it was ' +
            'installed on has not been synced at all.',
          timeout: 20_000,
        })
        .toBe(true);

      const bytes = await remote.readBinaryFile(rel);
      expect(bytes, `${rel} exists on the remote but could not be read back`).not.toBeNull();
      expect(
        bytes!.equals(Buffer.from(files[file], 'utf8')),
        `${rel} reached the remote with different bytes — the code channel corrupted it`,
      ).toBe(true);
    }

    expect(
      await readRemoteList(),
      `'${PROBE2_ID}' was pushed but never enabled on the remote — another machine would pull ` +
      'nothing, because the binary pull is driven by the enabled list',
    ).toContain(PROBE2_ID);
  });

  test('plugin data.json is NOT pushed with the code', async () => {
    // `data.json` is the plugin's SETTINGS. It is device-scoped by contract
    // (`.obsidian/user/<clientId>/…`, proven by restart-settings.spec.ts) and is
    // deliberately absent from PLUGIN_BINARY_FILES. If the code round-trip
    // carried it to the shared identity path, every device would fight over one
    // settings file — the exact collision the per-device layout exists to stop.
    fs.writeFileSync(
      localPath('plugins', PROBE2_ID, 'data.json'),
      JSON.stringify({ secret: 'device-A-only', n: 1 }),
      'utf8',
    );

    // Bump the version so the push path is genuinely EXERCISED on this connect.
    // Version-ordered convergence would otherwise skip `e2e-probe2` entirely
    // (remote == local) and the assertion below would pass without the code ever
    // having had the chance to leak `data.json`.
    await obsidian.cleanup();
    writeLocalPlugin(PROBE2_ID, probeFiles(PROBE2_ID, PROBE2_V_BUMPED));
    obsidian = await launchObsidian(shadowVaultPath);
    await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

    await expect
      .poll(async () => remote.readFile(`.obsidian/plugins/${PROBE2_ID}/manifest.json`), {
        message: 'the version bump never reached the remote, so the push path did not run',
        timeout: 20_000,
      })
      .toContain(`"version": "${PROBE2_V_BUMPED}"`);

    expect(
      await remote.exists(`.obsidian/plugins/${PROBE2_ID}/data.json`),
      'the plugin CODE round-trip carried data.json to the SHARED remote path. Plugin ' +
      'settings are device-scoped by design; a shared copy means every machine overwrites ' +
      'every other machine\'s settings on every save (#342 / #429).',
    ).toBe(false);
  });

  test('an OLDER local copy does not DOWNGRADE a NEWER remote plugin', async () => {
    // Another machine upgraded the plugin to 2.0.0 while this device still runs
    // 1.0.0. Convergence must be VERSION-ORDERED: pull up, never push down. A
    // last-writer-wins gate would push 1.0.0 back over 2.0.0, the other machine
    // would push 2.0.0 again, and the fleet would ping-pong forever.
    await obsidian.cleanup();

    await seedPluginOnRemote(remote, PROBE_ID, probeFiles(PROBE_ID, PROBE_V2));
    writeLocalPlugin(PROBE_ID, probeFiles(PROBE_ID, PROBE_V1));

    const seededRemote = await remote.readFile(`.obsidian/plugins/${PROBE_ID}/manifest.json`);
    expect(
      (JSON.parse(seededRemote ?? '{}') as { version?: string }).version,
      'fixture setup: the remote was not seeded at the newer version',
    ).toBe(PROBE_V2);

    obsidian = await launchObsidian(shadowVaultPath);
    await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

    await expect
      .poll(
        () =>
          (JSON.parse(
            fs.readFileSync(localPath('plugins', PROBE_ID, 'manifest.json'), 'utf8'),
          ) as { version?: string }).version,
        {
          message:
            `the newer remote copy of '${PROBE_ID}' was never pulled — this device is stuck ` +
            'on an old version of a plugin the rest of the fleet has already upgraded',
          timeout: 20_000,
        },
      )
      .toBe(PROBE_V2);

    const remoteManifest = await remote.readFile(`.obsidian/plugins/${PROBE_ID}/manifest.json`);
    expect(remoteManifest, `'${PROBE_ID}' vanished from the remote`).not.toBeNull();
    expect(
      (JSON.parse(remoteManifest!) as { version?: string }).version,
      'this device DOWNGRADED the remote plugin to its own older copy. Convergence is ' +
      'version-ordered on purpose (ShadowVaultBootstrap.ts:762,806): a last-writer-wins push ' +
      'makes every machine in the fleet overwrite the others on every connect, forever.',
    ).toBe(PROBE_V2);

    // …and the local `main.js` is the NEW code, not merely a new manifest.
    expect(
      fs.readFileSync(localPath('plugins', PROBE_ID, 'main.js'), 'utf8'),
      'the manifest was upgraded but the code was not — the device would report v2 and run v1',
    ).toBe(probeFiles(PROBE_ID, PROBE_V2)['main.js']);
  });

  test('uninstall: removing a plugin locally drops it from the remote enabled list', async () => {
    // ── EXPECTED TO FAIL: this encodes a real, unfixed defect ─────────────────
    // `pushCommunityPlugins` unions remote+local and then no-ops when the remote
    // already equals that union (ShadowVaultBootstrap.ts:698-702), so the remote
    // list is MONOTONIC — it can only grow. A removal made here can never reach
    // the remote; worse, the next `pullCommunityPlugins` (:652) merges the remote
    // list back in and RESURRECTS the plugin on this device.
    //
    // The assertions below are the correct user-facing behaviour and must NOT be
    // weakened. The fix belongs in the PRODUCT: the enabled list needs real
    // removal semantics (a tombstone, or a per-device "last known" set, so an id
    // that disappeared from a device that previously HAD it is treated as a
    // delete rather than as a device that simply never knew about it).
    await obsidian.cleanup();

    writeLocalList(readLocalList().filter((id) => id !== PROBE2_ID));
    fs.rmSync(localPath('plugins', PROBE2_ID), { recursive: true, force: true });

    obsidian = await launchObsidian(shadowVaultPath);
    await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

    await expect
      .poll(async () => (await readRemoteList()).includes(PROBE2_ID), {
        message:
          `uninstalling '${PROBE2_ID}' on this device never propagated: the remote enabled ` +
          'list still names it, so every other machine keeps it — and this device pulls it ' +
          'back on the next connect. A fleet-wide uninstall is impossible.',
        timeout: 20_000,
      })
      .toBe(false);

    expect(
      readLocalList(),
      `the connect RESURRECTED '${PROBE2_ID}' in this device's enabled list — the monotonic ` +
      'union in pushCommunityPlugins/pullCommunityPlugins makes an uninstall un-doable',
    ).not.toContain(PROBE2_ID);
  });
});
