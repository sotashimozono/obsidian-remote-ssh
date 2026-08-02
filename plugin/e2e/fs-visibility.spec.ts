import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
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
  parseIdList,
  preCleanRemoteFixtures,
  resetRemoteFixtures,
  type CommunityPluginsSnapshot,
  type FixtureFootprint,
} from './helpers/remote-reset';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #429 (the OPEN half) — "Claudian creates .md files in the local folder
 * instead of the remote vault".
 *
 * READ THIS BEFORE TOUCHING AN ASSERTION
 * ======================================
 * This spec began as the executable statement of a defect: every note a
 * plugin wrote under `basePath` stayed local, and every note on the remote was
 * invisible to raw `fs`. Most of it was RED on purpose. The product has since
 * been built to it, so it now states the CONTRACT — and the contract has one
 * genuine limit that the original text of this file did not anticipate.
 *
 * Two designs were on the table for the read side, and the first was refused:
 *
 *   (i)  mirror the note tree onto the shadow disk — REFUSED. That is a local
 *        clone of the remote vault, which is the thing this plugin exists to
 *        avoid; the whole point is that the vault is served, not copied.
 *   (ii) make Node's `fs` itself answer for the vault — TAKEN. `FsModulePatcher`
 *        takes over the read surface of the shared `fs` module for paths under
 *        the vault root, answering names and stats from `vault.fileMap` (free —
 *        no download) and content only when something asks for it.
 *
 * The limit, and why it is not negotiable
 * ---------------------------------------
 * A SYNCHRONOUS call cannot fetch from the remote. Not "does not yet": cannot.
 * The bridge that serves vault content runs an HTTP server on the renderer's
 * own event loop, so blocking the renderer to wait for it blocks the thread
 * that would answer — a self-deadlock. A revision of `getFullPath` shipped
 * exactly that and hung connect for minutes (`fs-sync-bridge-probe.spec.ts`
 * keeps measuring it).
 *
 * So the line falls between the two APIs, and this spec pins it on both sides:
 *
 *   fs.promises.readFile   → fetches on demand. That read IS the request.
 *   fs.readFileSync        → serves only what is already here (a note that was
 *   getFullPath / getFilePath  opened, written, or explicitly materialised).
 *                             Cold, it is ENOENT — by design, not by defect.
 *   fs.readdirSync / statSync  → names and sizes from the model, no download.
 *
 * That ENOENT is the one assertion in this file that was deliberately
 * inverted, and it is not a weakened bug report: it is the boundary, and a
 * green there means we did NOT quietly start mirroring the vault. Everything
 * else — the write side reaching the remote, a listing naming the notes, a
 * resolved path opening the right bytes — is still the user-facing contract
 * and still cannot be fixed by relaxing it.
 *
 * Two execution vehicles, both real
 * ---------------------------------
 *  (a) IN-PAGE RAW FS — `page.evaluate` + `window.require('fs')`. Obsidian's
 *      renderer has nodeIntegration, so this is byte-for-byte what a community
 *      plugin's own `require('fs')` gets. A precondition test asserts
 *      `window.require` really is there and FAILS LOUDLY if it is not: a silent
 *      fallback would leave the whole vehicle green while testing nothing.
 *  (b) A REAL PLUGIN — a loadable community plugin (`makeFakePlugin`) whose
 *      `onload()` runs the literal code from the issue. It is seeded ON THE
 *      REMOTE, so the connect-time community-plugins + plugin-binary pull
 *      (`src/main.ts:632-670`) stages it into the shadow vault; the shadow vault
 *      is then relaunched, because Obsidian only scans the plugins dir at
 *      startup. It is deliberately NOT seeded into the source scaffold vault:
 *      `ShadowVaultBootstrap` would snapshot it into
 *      `settings.pendingPluginSuggestions` and the shadow window would open a
 *      `PendingPluginsModal` that swallows Ctrl+P and hangs every later palette
 *      step.
 *
 * The first test is a CONTROL — a write through the vault API — and must PASS.
 * It isolates the real defect from harness faults: if the control is red, the
 * connect / adapter-patch / SFTP-verifier plumbing is broken and nothing else
 * in this file means anything.
 *
 * HARD-FAILS, never skips.
 */

const STAMP = Date.now().toString(36);

/**
 * The family prefix every note this spec seeds shares. Cleanup matches on THIS,
 * not on the four stamped names below: a run that crashed took its stamp with
 * it, and the only way to sweep its leftovers off the shared docker vault is to
 * recognise them by family.
 */
const NOTE_PREFIX = 'e2e-fs-';

/** Vault-relative note paths, unique to this run. */
const CONTROL_NOTE = `${NOTE_PREFIX}${STAMP}-control.md`;
const PLUGIN_NOTE = `${NOTE_PREFIX}${STAMP}-plugin.md`;
const REMOTE_ONLY_NOTE = `${NOTE_PREFIX}${STAMP}-remote-only.md`;
const REAL_PLUGIN_NOTE = `${NOTE_PREFIX}${STAMP}-claudian.md`;
/**
 * A second remote-only note that NOTHING in this file touches until the
 * cold-read test. Needed because these tests share one Obsidian window:
 * once anything has asked for a note it is materialised for good, so
 * "what happens before anyone asks" needs a note of its own.
 */
const COLD_NOTE = `${NOTE_PREFIX}${STAMP}-cold.md`;

const CONTROL_BODY = `# control ${STAMP}\n\nwritten through app.vault.adapter.write()\n`;
const PLUGIN_BODY = `# plugin ${STAMP}\n\nwritten with raw fs under adapter.basePath\n`;
const REMOTE_ONLY_BODY = `# remote only ${STAMP}\n\nseeded straight onto the remote over SFTP\n`;
const COLD_BODY = `# cold ${STAMP}

nobody asks for this until the cold-read test
`;
const REAL_PLUGIN_BODY = `# claudian repro ${STAMP}\n\nfs.writeFileSync from a plugin onload()\n`;

/** A note the docker fixture vault always has — the read-side subject. */
const FIXTURE_NOTE = 'remote_demo1.md';

/** The #429 reproduction plugin (vehicle b). */
const FS_PLUGIN_ID = 'e2e-fs-probe';

/**
 * Everything this spec puts on the SHARED, PERSISTENT docker vault — and
 * therefore owes back. A fixture plugin left enabled in the remote's
 * `community-plugins.json` is pulled into the shadow vault of every LATER spec
 * at connect (`src/main.ts:632-670`), so leaving one behind reddens tests this
 * file has nothing to do with. The product cannot undo it either: the enabled
 * list is a monotonic union (`ShadowVaultBootstrap.ts:698-702`).
 */
const FOOTPRINT: FixtureFootprint = {
  pluginIds: [FS_PLUGIN_ID],
  notePrefixes: [NOTE_PREFIX],
};

/**
 * `onload()` body of the reproduction plugin: literally the code from the
 * issue. The outcome is parked on `window.__E2E_FS_PROBE__` so the test can
 * tell three very different failures apart — "the plugin never ran", "the
 * plugin ran and the write threw", and "the plugin ran, the write succeeded,
 * and the bytes went nowhere near the remote" (the actual bug).
 */
const FS_PLUGIN_ONLOAD = [
  "const fs = require('fs'); const path = require('path');",
  'try {',
  `  const p = path.join(this.app.vault.adapter.basePath, ${JSON.stringify(REAL_PLUGIN_NOTE)});`,
  `  fs.writeFileSync(p, ${JSON.stringify(REAL_PLUGIN_BODY)});`,
  '  window.__E2E_FS_PROBE__ = { wrote: p, error: null };',
  '} catch (e) { window.__E2E_FS_PROBE__ = { wrote: null, error: String(e) }; }',
].join('\n    ');

/** What the reproduction plugin reports back from its `onload()`. */
interface FsProbeResult {
  wrote: string | null;
  error: string | null;
}

/**
 * The slice of Node's `fs` / `path` these tests use. Structural types only —
 * they exist so the in-renderer code is type-checked without importing Node
 * types into a browser context (the real modules come from `window.require`).
 */
interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: 'utf8'): string;
  writeFileSync(p: string, data: string): void;
  readdirSync(p: string): string[];
}
interface PathLike {
  join(...parts: string[]): string;
}

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
let shadowVaultPath: string;
/**
 * The remote's community-plugins.json before this spec touched it (raw === null
 * means it did not exist, and restoring must DELETE it rather than write `[]`).
 * Captured after the pre-clean, so a leftover fixture id from a crashed run can
 * never be baked into what we call "original".
 */
let communityPluginsSnapshot: CommunityPluginsSnapshot = { raw: null };

test.beforeAll(async () => {
  await assertSshdReachable();

  remote = new RemoteVerifier();
  if (!(await remote.connect())) {
    throw new Error(
      'RemoteVerifier could not connect to the docker test sshd even though ' +
      'the port is open. This spec hard-fails rather than skipping.',
    );
  }

  // ── Defensive PRE-CLEAN, before anything is seeded ───────────────────────
  // The docker vault is shared and persists across specs. A previous run that
  // crashed leaves `e2e-fs-*` notes at the root, `e2e-fs-probe` under
  // `.obsidian/plugins/` (and under the per-device `.obsidian/user/<clientId>/`),
  // and its id still named in the remote enabled list — which the product's
  // monotonic union can never have removed. Purge all of it, so this spec never
  // inherits another run's garbage.
  await preCleanRemoteFixtures(remote, FOOTPRINT);

  // ── Seed the REMOTE before anything connects ─────────────────────────────
  // Both fixtures must exist on the remote before the shadow window's connect,
  // because that connect is when the product reads the remote:
  //   - the note is picked up by the initial vault-model populate;
  //   - the plugin binary is staged onto the shadow disk by the connect-time
  //     community-plugins + plugin-binary round-trip (`src/main.ts:632-670`).
  await remote.writeFile(REMOTE_ONLY_NOTE, REMOTE_ONLY_BODY);
  await remote.writeFile(COLD_NOTE, COLD_BODY);

  const pluginFiles: Record<string, string> = {
    ...makeFakePlugin({ id: FS_PLUGIN_ID, version: '1.0.0', onloadBody: FS_PLUGIN_ONLOAD }),
  };
  await seedPluginOnRemote(remote, FS_PLUGIN_ID, pluginFiles);

  // Enable it in the REMOTE's community-plugins.json — that list is what the
  // connect-time pull merges into the shadow vault and what decides which
  // binaries get staged. Merged rather than overwritten (so a concurrent
  // fixture's id survives) and remembered, so `afterAll` can restore it.
  communityPluginsSnapshot = await captureCommunityPlugins(remote);
  const enabledIds = new Set<string>(parseIdList(communityPluginsSnapshot.raw));
  enabledIds.add(FS_PLUGIN_ID);
  await remote.writeFile(COMMUNITY_PLUGINS_REL, JSON.stringify([...enabledIds]));

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // Building blocks rather than `connectAndOpenShadow`, because the shadow
  // vault PATH is itself part of the subject matter here: it is the local root
  // that `adapter.basePath` hands out to plugins.
  shadowVaultPath = await connectAndWaitForShadowVault(obsidian.page, scaffold.vaultPath);
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);

  // The adapter is only patched at layout-ready, AFTER the SSH connect. Every
  // test below reads `app.vault.adapter`, so they must all run against the
  // PATCHED adapter — a red obtained from the stock FileSystemAdapter would
  // prove nothing about the product.
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
});

test.afterAll(async () => {
  // MOST OF THIS SPEC IS EXPECTED TO FAIL, so cleanup lives here — `afterAll`
  // runs whatever the tests did — and every step inside `resetRemoteFixtures` is
  // independently guarded, so one failure cannot skip the rest. Reverting the
  // remote is unavoidably the harness's job: the product's enabled list is a
  // monotonic union and will never drop `e2e-fs-probe` on its own, and a fixture
  // plugin still named there is pulled in, staged and LOADED by the shadow vault
  // of every spec that runs after this one.
  await obsidian?.cleanup().catch(() => {});
  if (remote) {
    await resetRemoteFixtures(remote, FOOTPRINT, communityPluginsSnapshot);
    await remote.disconnect();
  }
  scaffold?.cleanup();
});

/** `app.vault.adapter.basePath`, as the renderer sees it. */
function readBasePath(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const app = (window as unknown as {
      app?: { vault?: { adapter?: { basePath?: unknown } } };
    }).app;
    return app?.vault?.adapter?.basePath;
  });
}

/** Is `rel` in the vault model (file explorer, search, other plugins)? */
function inVaultModel(page: Page, rel: string): Promise<boolean> {
  return page.evaluate((p) => {
    const app = (window as unknown as {
      app?: { vault?: { getAbstractFileByPath?: (p: string) => unknown } };
    }).app;
    return app?.vault?.getAbstractFileByPath?.(p) != null;
  }, rel);
}

/** Absolute path of a vault-relative note on the LOCAL shadow disk. */
function localPathOf(relative: string): string {
  return path.join(shadowVaultPath, ...relative.split('/'));
}

test.describe('a plugin\'s view of the filesystem must be the REMOTE vault (#429)', () => {
  /**
   * CONTROL — PREDICT PASS. The vault API is the one surface that IS fully
   * patched (`AdapterManager.PATCHED_METHODS` includes `write`), so a write
   * through it must reach the remote. If this is red, every red below is
   * uninterpretable.
   */
  test('control: a write through the vault API reaches the remote', async () => {
    const writeErr = await obsidian.page.evaluate(
      async ({ rel, body }) => {
        const app = (window as unknown as {
          app?: { vault?: { adapter?: { write?: (p: string, d: string) => Promise<void> } } };
        }).app;
        const adapter = app?.vault?.adapter;
        if (!adapter?.write) return 'no adapter on app.vault.adapter';
        try {
          await adapter.write(rel, body);
          return null;
        } catch (e) {
          return String(e);
        }
      },
      { rel: CONTROL_NOTE, body: CONTROL_BODY },
    );
    expect(writeErr, 'the vault-API write itself failed').toBeNull();

    await expect
      .poll(() => remote.readFile(CONTROL_NOTE), {
        message:
          'a write through app.vault.adapter.write() never reached the remote. This is ' +
          'the CONTROL: the harness (connect, adapter patch, SFTP verifier) is broken, ' +
          'so treat every other result in this file as void until it is fixed.',
        timeout: 15_000,
      })
      .toBe(CONTROL_BODY);
  });

  /**
   * PRECONDITION — PREDICT PASS. The whole raw-fs vehicle rests on Obsidian's
   * renderer exposing Node. Asserted explicitly and never worked around: a spec
   * that quietly stopped exercising `require('fs')` would go green while the
   * bug it exists for got worse.
   */
  test('window.require is available in the renderer (vehicle precondition)', async () => {
    const requireType = await obsidian.page.evaluate(
      () => typeof (window as unknown as { require?: unknown }).require,
    );
    expect(
      requireType,
      'window.require is missing — this Obsidian build\'s renderer has no ' +
      'nodeIntegration, so a community plugin could not call require("fs") at all and ' +
      'the raw-fs half of this spec is untestable as written. Do NOT paper over this ' +
      'with a fallback: fix the vehicle.',
    ).toBe('function');
  });

  /**
   * PREDICT PASS — #170 made `basePath` a defined, real directory (before it,
   * plugins joining onto `undefined` crashed outright), and this pins that fix.
   * It is also the premise of every red below: the path IS real, which is
   * exactly why plugins trust it and why their writes vanish into it.
   */
  test('basePath is defined and points at a real existing directory', async () => {
    const basePath = await readBasePath(obsidian.page);
    expect(typeof basePath, 'adapter.basePath must be a string (#170)').toBe('string');
    expect(String(basePath).length, 'adapter.basePath must not be empty').toBeGreaterThan(0);

    const exists = await obsidian.page.evaluate(() => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const bp = (window as unknown as {
        app?: { vault?: { adapter?: { basePath?: string } } };
      }).app?.vault?.adapter?.basePath;
      if (typeof bp !== 'string') throw new Error(`basePath is not a string: ${String(bp)}`);
      return (req('fs') as FsLike).existsSync(bp);
    });
    expect(
      exists,
      `adapter.basePath (${String(basePath)}) is not an existing directory on disk`,
    ).toBe(true);
  });

  /**
   * THE DEFECT, NOW THE CONTRACT.
   *
   * The literal #429 operation: a plugin joins a name onto `adapter.basePath`
   * and writes it with Node's `fs`. The only sane expectation — `basePath` is
   * advertised as the vault's folder — is that the note is now in the user's
   * vault, i.e. on the remote.
   *
   * The corroborating local-disk assertion runs FIRST and is expected to PASS:
   * it proves the bytes landed in the shadow root rather than nowhere, so the
   * remote assertion's red is conclusively "wrong destination" and not "the
   * write failed".
   */
  test('a file a plugin writes under adapter.basePath reaches the REMOTE vault', async () => {
    const wrote = await obsidian.page.evaluate((rel) => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const bp = (window as unknown as {
        app?: { vault?: { adapter?: { basePath?: string } } };
      }).app?.vault?.adapter?.basePath;
      if (typeof bp !== 'string') throw new Error(`basePath is not a string: ${String(bp)}`);
      const target = (req('path') as PathLike).join(bp, rel.name);
      (req('fs') as FsLike).writeFileSync(target, rel.body);
      return target;
    }, { name: PLUGIN_NOTE, body: PLUGIN_BODY });
    expect(typeof wrote, 'the in-page fs.writeFileSync did not return its target path').toBe(
      'string',
    );

    // Corroboration (expected to PASS): the file DID land — on the local shadow
    // disk. Without this, the red below could be read as "the write threw".
    expect(
      fs.existsSync(localPathOf(PLUGIN_NOTE)),
      `the plugin's write did not even reach the local shadow disk ` +
      `(${localPathOf(PLUGIN_NOTE)}) — the raw-fs vehicle is broken, so the remote ` +
      'assertion below would be inconclusive',
    ).toBe(true);

    // The actual contract.
    await expect
      .poll(() => remote.exists(PLUGIN_NOTE), {
        message:
          `#429: a plugin wrote ${PLUGIN_NOTE} under adapter.basePath (it landed at ` +
          `${localPathOf(PLUGIN_NOTE)}, asserted above) and it never reached the remote ` +
          'vault. SftpDataAdapter.basePath (SftpDataAdapter.ts:155-166) hands out the ' +
          'LOCAL shadow root, and nothing mirrors or watches the note tree, so the bytes ' +
          'stay there forever. Do NOT weaken this assertion: the fix is a mirrored note ' +
          'tree plus a local→remote watcher, or an FS-backed view of the remote.',
        timeout: 20_000,
      })
      .toBe(true);

    expect(
      await remote.readFile(PLUGIN_NOTE),
      'the note reached the remote, but with the wrong content',
    ).toBe(PLUGIN_BODY);
  });

  /**
   * COROLLARY. Set the remote aside: does the file reach the vault the user is
   * looking at? It only does because something watches the shadow disk and
   * feeds what it finds into `vault.fileMap` (`LocalWriteWatcher`). Without
   * that the note is absent from the file explorer, from search, and from
   * every other plugin — present on disk, non-existent from the user's seat.
   */
  test('a file a plugin writes under adapter.basePath appears in the vault model', async () => {
    await obsidian.page.evaluate((rel) => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const bp = (window as unknown as {
        app?: { vault?: { adapter?: { basePath?: string } } };
      }).app?.vault?.adapter?.basePath;
      if (typeof bp !== 'string') throw new Error(`basePath is not a string: ${String(bp)}`);
      const target = (req('path') as PathLike).join(bp, rel.name);
      (req('fs') as FsLike).writeFileSync(target, rel.body);
      return target;
    }, { name: PLUGIN_NOTE, body: PLUGIN_BODY });

    await expect
      .poll(() => inVaultModel(obsidian.page, PLUGIN_NOTE), {
        message:
          `#429 corollary: ${PLUGIN_NOTE} was written under adapter.basePath but never ` +
          'entered vault.fileMap — it is invisible in the file explorer, in search, and ' +
          'to every other plugin. The note tree is virtual (SftpDataAdapter.ts:155-166) ' +
          'and nothing watches the shadow disk for a plugin\'s raw fs writes.',
        timeout: 20_000,
      })
      .toBe(true);
  });

  /**
   * READ SIDE — the contract, in three tests.
   *
   * A synchronous call cannot reach the remote. Not "does not yet": cannot.
   * The bridge that serves vault content runs an HTTP server on the renderer's
   * own event loop, so blocking the renderer to wait for it blocks the thread
   * that would answer — a self-deadlock that hung connect for minutes when a
   * revision of `getFullPath` shipped it. The only synchronous source of bytes
   * is therefore what is already here.
   *
   * The line falls between the two APIs, and these three pin it:
   *   1. this one — `readFileSync` on a note nobody asked for: ENOENT;
   *   2. `fs.promises.readFile` on the same kind of note: the real bytes;
   *   3. the transition — invisible, then visible, and the only thing that
   *      changed is that somebody asked.
   *
   * The note was seeded in `beforeAll`, before the shadow window connected, so
   * it is in the model by construction — asserted FIRST, so the ENOENT below
   * is about materialisation and not about a note that never arrived.
   */
  test('a note nobody has asked for is NOT readable synchronously — that is the line', async () => {
    await expect
      .poll(() => inVaultModel(obsidian.page, REMOTE_ONLY_NOTE), {
        message:
          `${REMOTE_ONLY_NOTE} was seeded on the remote before connect but never appeared ` +
          'in the vault model — that is the remote→vault path being broken, a different ' +
          '(and worse) bug than the one this test is about',
        timeout: 30_000,
      })
      .toBe(true);

    const read = await obsidian.page.evaluate((rel) => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const bp = (window as unknown as {
        app?: { vault?: { adapter?: { basePath?: string } } };
      }).app?.vault?.adapter?.basePath;
      if (typeof bp !== 'string') throw new Error(`basePath is not a string: ${String(bp)}`);
      const target = (req('path') as PathLike).join(bp, rel);
      try {
        return { body: (req('fs') as FsLike).readFileSync(target, 'utf8'), error: null as string | null };
      } catch (e) {
        return { body: null as string | null, error: String(e) };
      }
    }, REMOTE_ONLY_NOTE);

    // Cold: nobody has asked for this note, so the synchronous surface
    // has nothing to hand over. This is the CONTRACT, not a defect —
    // the async test below is the half that fetches.
    expect(
      read.error,
      'a synchronous read of a note nobody has asked for returned bytes. That means either ' +
      'the vault is being mirrored to disk — the design this plugin exists to avoid — or ' +
      'a blocking fetch crept back in, which deadlocks: the bridge that would serve the ' +
      'content runs on the very thread being blocked.',
    ).toContain('ENOENT');
  });

  /**
   * The on-demand half, and the one plugins should use.
   *
   * `fs.promises.readFile` can await, so it materialises the file it is asked
   * for and returns the real bytes. This is what "a request materialises a
   * file" means in practice.
   */
  test('a remote-only note IS readable via fs.promises.readFile (the on-demand path)', async () => {
    const read = await obsidian.page.evaluate(async (rel) => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const bp = (window as unknown as {
        app?: { vault?: { adapter?: { basePath?: string } } };
      }).app?.vault?.adapter?.basePath;
      if (typeof bp !== 'string') throw new Error(`basePath is not a string: ${String(bp)}`);
      const target = (req('path') as PathLike).join(bp, rel);
      const fsp = (req('fs') as { promises?: { readFile?: (p: string, e: string) => Promise<string> } })
        .promises;
      if (!fsp?.readFile) return { body: null as string | null, error: 'fs.promises.readFile is missing' };
      try {
        return { body: await fsp.readFile(target, 'utf8'), error: null as string | null };
      } catch (e) {
        return { body: null as string | null, error: String(e) };
      }
    }, REMOTE_ONLY_NOTE);

    expect(
      read.error,
      `#429 read side: ${REMOTE_ONLY_NOTE} is in the vault but fs.promises.readFile under ` +
      'adapter.basePath could not produce it. This is the path that CAN fetch — nothing ' +
      'blocks on it — so a failure here means on-demand materialisation is not working at ' +
      'all, and every plugin that reads notes through Node sees an empty vault.',
    ).toBeNull();

    expect(
      read.body,
      'the file was readable, but its content is not the note that is on the remote',
    ).toBe(REMOTE_ONLY_BODY);
  });

  /**
   * The line, stated as a transition rather than a verdict: the same note is
   * invisible to `readFileSync` and then visible, and the only thing that
   * changed is that somebody asked for it.
   */
  test('readFileSync sees a note once something has asked for it — and not before', async () => {
    const probe = await obsidian.page.evaluate(async (rel) => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const bp = (window as unknown as {
        app?: { vault?: { adapter?: { basePath?: string } } };
      }).app?.vault?.adapter?.basePath;
      if (typeof bp !== 'string') throw new Error(`basePath is not a string: ${String(bp)}`);
      const target = (req('path') as PathLike).join(bp, rel);
      const fsMod = req('fs') as FsLike & {
        promises?: { readFile?: (p: string, e: string) => Promise<string> };
      };

      const readSync = (): { body: string | null; error: string | null } => {
        try {
          return { body: fsMod.readFileSync(target, 'utf8') as string, error: null };
        } catch (e) {
          return { body: null, error: String(e) };
        }
      };

      const before = readSync();
      // The request. Anything that materialises would do — opening the
      // note in the UI, or a plugin awaiting the promise API.
      await fsMod.promises?.readFile?.(target, 'utf8');
      return { before, after: readSync() };
    }, COLD_NOTE);

    expect(
      probe.before.error,
      'the note was already on disk before anything asked for it — something materialises ' +
      'eagerly, which is the mirror this design refuses',
    ).toContain('ENOENT');

    expect(
      probe.after.error,
      'the note was asked for and materialised, but a synchronous read still cannot see it ' +
      '— the materialised copy is not landing where the path points',
    ).toBeNull();
    expect(probe.after.body, 'the materialised copy is not the note on the remote').toBe(COLD_BODY);
  });

  /**
   * `getFullPath` must return a path that resolves — otherwise it hands out
   * something that LOOKS right and points at nothing, which is worse than
   * failing, because the caller only finds out at open time.
   *
   * It is synchronous, so it can only serve bytes that are already here: it
   * materialises from the read cache. The note is read first, which is what a
   * plugin resolving a TFile it is working with would have done anyway.
   *
   * Shape and existence are asserted SEPARATELY on purpose, so the diagnostic
   * distinguishes "wrong path" from "right-looking path with no file behind it"
   * — the latter being the actual product bug.
   */
  test('getFullPath returns a path that resolves to the file', async () => {
    const basePath = String(await readBasePath(obsidian.page));

    const fullPath = await obsidian.page.evaluate((rel) => {
      const adapter = (window as unknown as {
        app?: { vault?: { adapter?: { getFullPath?: (p: string) => string } } };
      }).app?.vault?.adapter;
      if (typeof adapter?.getFullPath !== 'function') return null;
      return adapter.getFullPath(rel);
    }, FIXTURE_NOTE);

    expect(fullPath, 'app.vault.adapter has no getFullPath at all').not.toBeNull();

    // Shape — likely PASSES: the stock implementation does join onto basePath.
    expect(
      fullPath!.startsWith(basePath),
      `getFullPath('${FIXTURE_NOTE}') = ${fullPath} is not even under basePath (${basePath})`,
    ).toBe(true);

    // Behaviour. `getFullPath` is synchronous, so it can only hand back a
    // path to bytes that are already here — it asks for the file, and that
    // request is served from the read cache when the note has been read.
    // Reading it through the vault API first is what a plugin resolving a
    // TFile it is working with would have done anyway.
    const probe = await obsidian.page.evaluate(async (args) => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const adapter = (window as unknown as {
        app?: { vault?: { adapter?: {
          read?: (p: string) => Promise<string>;
          getFullPath?: (p: string) => string;
        } } };
      }).app?.vault?.adapter;
      await adapter?.read?.(args.rel);          // the note is now in the read cache
      adapter?.getFullPath?.(args.rel);         // ask again, now that it can be served
      const fsMod = req('fs') as FsLike;
      if (!fsMod.existsSync(args.p)) return { exists: false, body: null as string | null };
      try {
        return { exists: true, body: fsMod.readFileSync(args.p, 'utf8') as string | null };
      } catch (e) {
        return { exists: true, body: `<<unreadable: ${String(e)}>>` as string | null };
      }
    }, { p: fullPath!, rel: FIXTURE_NOTE });

    expect(
      probe.exists,
      `#429: getFullPath('${FIXTURE_NOTE}') returned ${fullPath}, which does not exist — ` +
      'even though the note had just been read, so its bytes were in the read cache and ' +
      'materialising them required no network at all. A plugin that resolves a TFile it ' +
      'is already working with gets a path to nothing.',
    ).toBe(true);

    expect(
      probe.body,
      `the file at getFullPath('${FIXTURE_NOTE}') is not the note that is on the remote`,
    ).toBe(await remote.readFile(FIXTURE_NOTE));
  });

  /**
   * `getFilePath` is the `file://` surface plugins hand to `<img>`,
   * `shell.openPath`, external editors and `URL`-based tooling. Same
   * contract as `getFullPath`: synchronous, so it resolves for a note
   * whose bytes are here — which, for anything the user is looking at,
   * they are.
   */
  test('getFilePath returns a file:// URL that resolves', async () => {
    const filePath = await obsidian.page.evaluate(async (rel) => {
      const adapter = (window as unknown as {
        app?: { vault?: { adapter?: {
          read?: (p: string) => Promise<string>;
          getFilePath?: (p: string) => unknown;
        } } };
      }).app?.vault?.adapter;
      if (typeof adapter?.getFilePath !== 'function') return null;
      await adapter.read?.(rel);      // the note is now in the read cache
      return String(adapter.getFilePath(rel));
    }, FIXTURE_NOTE);

    expect(filePath, 'app.vault.adapter has no getFilePath at all').not.toBeNull();

    // Shape, separately: a non-file:// return is a different bug from a
    // file:// URL that points at nothing, and the message must say which.
    expect(
      filePath!.startsWith('file://'),
      `getFilePath('${FIXTURE_NOTE}') returned ${filePath}, which is not a file:// URL`,
    ).toBe(true);

    const onDisk = fileURLToPath(filePath!);
    expect(
      fs.existsSync(onDisk),
      `#429: getFilePath('${FIXTURE_NOTE}') = ${filePath} resolves to ${onDisk}, which does ` +
      'not exist — even though the note had just been read, so materialising it required ' +
      'no network. Anything that follows that URL — an <img>, shell.openPath, an external ' +
      'editor — opens nothing.',
    ).toBe(true);
  });

  /**
   * The most literal statement of "can the plugin see the vault": a directory
   * listing of `basePath`. It must name the notes, not just the `.obsidian`
   * config tree that happens to be mirrored — and it must do so without
   * downloading anything, because the names come from the vault model. The
   * actual listing is quoted in the failure message, because the shape of what
   * a plugin DOES see is the diagnosis.
   */
  test('a plugin reading the vault via fs.readdirSync(basePath) sees the vault\'s notes', async () => {
    const entries = await obsidian.page.evaluate(() => {
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (typeof req !== 'function') throw new Error('window.require is unavailable');
      const bp = (window as unknown as {
        app?: { vault?: { adapter?: { basePath?: string } } };
      }).app?.vault?.adapter?.basePath;
      if (typeof bp !== 'string') throw new Error(`basePath is not a string: ${String(bp)}`);
      return (req('fs') as FsLike).readdirSync(bp);
    });

    expect(
      entries,
      `#429: fs.readdirSync(adapter.basePath) does not list ${FIXTURE_NOTE}. A plugin that ` +
      'enumerates the vault through the filesystem sees only what is mirrored onto the ' +
      'shadow disk (the .obsidian config tree) and none of the notes — the note tree is ' +
      `virtual (SftpDataAdapter.ts:155-166). Actual listing: ${JSON.stringify(entries)}`,
    ).toContain(FIXTURE_NOTE);
  });

  /**
   * THE FIELD REPORT, AS A STANDING TEST.
   *
   * Vehicle (b): a genuine, loadable community plugin whose `onload()` runs the
   * exact code from #429. Nothing is simulated — Obsidian's own plugin loader
   * executes it, with its own `require('fs')`, against its own
   * `this.app.vault.adapter`.
   *
   * Its binary was seeded on the remote in `beforeAll` and staged onto the
   * shadow disk by the connect-time pull (`src/main.ts:664-670`); Obsidian only
   * scans the plugins dir at startup, so the shadow vault is relaunched here to
   * load it. This test runs LAST for that reason — it leaves behind a fresh
   * window that no earlier test depends on.
   */
  test('REAL-PLUGIN REPRODUCTION: a plugin\'s fs.writeFileSync in onload() reaches the remote', async () => {
    expect(
      fs.existsSync(path.join(shadowVaultPath, '.obsidian', 'plugins', FS_PLUGIN_ID, 'main.js')),
      'the reproduction plugin was never staged onto the shadow disk from the remote — ' +
      'the connect-time plugin-binary pull (src/main.ts:664-670) did not run, so this ' +
      'test has no vehicle. That is a product/harness failure to FIX, not to skip.',
    ).toBe(true);

    // Relaunch so Obsidian's startup scan picks the plugin up.
    await obsidian.cleanup();
    obsidian = await launchObsidian(shadowVaultPath);
    await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

    // `launchObsidian` flips restricted mode off, which loads everything listed
    // in community-plugins.json. Belt and braces for builds where the
    // freshly-pulled id has not yet made it into the enabled set: enable it
    // explicitly, exactly as a user would from the Community plugins pane.
    await obsidian.page.evaluate(async (id) => {
      const plugins = (window as unknown as {
        app?: {
          plugins?: {
            plugins?: Record<string, unknown>;
            enablePluginAndSave?: (id: string) => Promise<void>;
            enablePlugin?: (id: string) => Promise<void>;
          };
        };
      }).app?.plugins;
      if (!plugins) throw new Error('app.plugins unavailable in the shadow window');
      if (plugins.plugins?.[id]) return;
      if (plugins.enablePluginAndSave) await plugins.enablePluginAndSave(id);
      else if (plugins.enablePlugin) await plugins.enablePlugin(id);
      else throw new Error('app.plugins has no enablePlugin/enablePluginAndSave');
    }, FS_PLUGIN_ID);

    const readProbe = (): Promise<FsProbeResult | null> =>
      obsidian.page.evaluate(
        () =>
          (window as unknown as { __E2E_FS_PROBE__?: FsProbeResult }).__E2E_FS_PROBE__ ?? null,
      );

    await expect
      .poll(async () => (await readProbe()) !== null, {
        message:
          `the ${FS_PLUGIN_ID} plugin never ran its onload() in the shadow vault — without ` +
          'that, the #429 reproduction has no vehicle at all',
        timeout: 30_000,
      })
      .toBe(true);

    const probe = await readProbe();
    expect(probe, 'the plugin probe vanished between polls').not.toBeNull();

    expect(
      probe!.error,
      'the plugin\'s fs.writeFileSync(path.join(adapter.basePath, note)) THREW inside ' +
      'onload(): a community plugin doing the most ordinary thing imaginable cannot even ' +
      `complete its write against a remote vault. Error: ${probe!.error}`,
    ).toBeNull();

    await expect
      .poll(() => remote.exists(REAL_PLUGIN_NOTE), {
        message:
          `#429, verbatim: the ${FS_PLUGIN_ID} plugin ran fs.writeFileSync(path.join(` +
          `this.app.vault.adapter.basePath, '${REAL_PLUGIN_NOTE}')) in onload(), the write ` +
          `SUCCEEDED (it wrote ${probe!.wrote}), and the note is nowhere on the remote ` +
          'vault. This is exactly what users report: "Claudian creates .md files in the ' +
          'local folder instead of the remote vault". The fix belongs in the product — ' +
          'mirror the note tree and watch it, or give basePath / getFullPath / getFilePath ' +
          'an FS-backed view of the remote — never in this assertion.',
        timeout: 30_000,
      })
      .toBe(true);

    expect(
      await remote.readFile(REAL_PLUGIN_NOTE),
      'the plugin\'s note reached the remote, but with the wrong content',
    ).toBe(REAL_PLUGIN_BODY);
  });
});
