import { test, expect } from '@playwright/test';
import {
  launchObsidian,
  connectAndWaitForShadowVault,
  waitForShadowVaultLoaded,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { logPathFor, waitForLog, assertAtMost } from './helpers/log-oracle';
import { assertSshdReachable } from './helpers/sshd';

/**
 * Connect-lifecycle e2e — the coverage that was missing while a
 * broken connect shipped to stable (1.0.49).
 *
 * Every prior spec "gracefully skips if sshd is unreachable" and only
 * asserts that *something* appeared — so a connect that opens SFTP
 * then stalls in `AdapterManager.patch` / `runAutoConnect` /
 * `populateVaultFromRemote` (the exact production incident: SFTP
 * channel open, then no patch/populate logs, then a WindowSpawner
 * re-spawn loop) passed CI green. This spec is deliberately the
 * opposite:
 *
 *   - HARD FAIL, never skip. sshd down ⇒ test failure, not a skip.
 *   - Drives the FULL real lifecycle in real Obsidian over SFTP
 *     (the transport the incident was reported on):
 *       scaffold → Connect → shadow spawn → shadow window
 *       auto-connect → AdapterManager.patch → runAutoConnect →
 *       populateVaultFromRemote.
 *   - Asserts the structured-log trail that was *absent* in the
 *     incident, AND bounds the WindowSpawner count that was *runaway*.
 *
 * Expected to be RED on the current build (reproduces the incident),
 * GREEN once the connect orchestration is fixed. That ordering is the
 * point — the test proves the fix, and guards the regression.
 */

test.setTimeout(240_000);

test.describe('connect lifecycle (SFTP)', () => {
  let scaffold: ScaffoldResult;
  let scaffoldHandle: ObsidianHandle | null = null;
  let shadowHandle: ObsidianHandle | null = null;

  test.beforeAll(async () => {
    await assertSshdReachable();
    scaffold = scaffoldTestVault({ transport: 'sftp' });
  });

  test.afterAll(async () => {
    try { await shadowHandle?.cleanup(); } catch { /* best effort */ }
    try { await scaffoldHandle?.cleanup(); } catch { /* best effort */ }
    scaffold?.cleanup();
  });

  test('Connect → patch → runAutoConnect → populate completes end-to-end over SFTP', async () => {
    // Per-attempt log cutoff. `beforeAll` builds the scaffold once, so
    // a Playwright retry reuses the same scaffold/shadow dirs and the
    // same APPEND-mode console.log files. Without this gate the retry
    // would match the FIRST attempt's stale `SFTP channel open` /
    // `Adapter patched` / `populateVaultFromRemote` lines and race
    // past straight to the File Explorer DOM check (the exact 13s
    // false-fail seen in run 26010373894). Every oracle below is
    // scoped to lines emitted at/after this instant.
    const since = new Date().toISOString();

    // 1. Real Obsidian on the scaffold vault, plugin force-loaded.
    scaffoldHandle = await launchObsidian(scaffold.vaultPath);

    // 2. Drive the real Connect command (retries the palette flow if
    //    CI Obsidian wasn't interactive yet); the plugin bootstraps a
    //    shadow vault and registers it in obsidian.json.
    const shadowVaultPath = await connectAndWaitForShadowVault(
      scaffoldHandle.page, scaffold.vaultPath, 45_000,
    );

    // 3. The connecting (scaffold) window must NOT be stuck
    //    re-bootstrapping/re-spawning the shadow — the production
    //    symptom was dozens of these within milliseconds.
    assertAtMost(
      logPathFor(scaffold.vaultPath),
      /WindowSpawner: firing obsidian:\/\/open/,
      3,
      'scaffold window must not loop-spawn the shadow vault',
      since,
    );

    // 4. Hand off to a fresh Obsidian on the shadow vault — this is
    //    the window that auto-connects (runAutoConnect on layout).
    await scaffoldHandle.cleanup();
    scaffoldHandle = null;
    shadowHandle = await launchObsidian(shadowVaultPath);
    const shadowLog = logPathFor(shadowVaultPath);

    // 5. The post-SFTP-open orchestration that was SILENT in the
    //    incident MUST produce its trail:
    //    a) SSH/SFTP actually opened
    await waitForLog(
      shadowLog,
      /SFTP channel open/,
      60_000,
      'SFTP channel must open',
      since,
    );
    //    b) the adapter was patched over the SFTP transport
    await waitForLog(
      shadowLog,
      /Adapter patched via SFTP/,
      60_000,
      'adapter must patch after SFTP open (absent in the incident)',
      since,
    );
    //    c) the remote tree was actually walked into the vault model.
    //    A partial / empty populate STILL logs this line ("0 entries")
    //    — the literal production symptom (SFTP open, then an empty
    //    vault). Asserting the line appeared is not enough; assert the
    //    walk yielded a non-empty tree.
    const populateEntry = await waitForLog(
      shadowLog,
      /populateVaultFromRemote\(shadow-[^)]*\):.*?\d+ entries/,
      90_000,
      'vault must populate from remote (absent in the incident)',
      since,
    );
    const populatedCount = Number(
      /(\d+) entries/.exec(populateEntry.msg ?? '')?.[1] ?? '0',
    );
    expect(
      populatedCount,
      'populate must walk a non-empty remote tree — 0 entries is the ' +
      'empty-vault incident the line-only assertion would pass',
    ).toBeGreaterThan(0);

    // 6. And the shadow window must not itself be loop-spawning.
    assertAtMost(
      shadowLog,
      /WindowSpawner: firing obsidian:\/\/open/,
      2,
      'shadow window must not loop-spawn',
      since,
    );

    // 7. Observable end state: the remote vault is LOADED. Assert the
    //    product's own model (getMarkdownFiles()>=1 + a file-explorer
    //    leaf) — the exact "the remote tree loaded" outcome the field
    //    report is about. Diagnosed across runs 26015295742 /
    //    26016246390: the model + leaf are consistently correct
    //    (built Nf, 0 errors; leaf visible 300x717; navTitles>0) but
    //    headless Obsidian paints the File Explorer tree lazily, so a
    //    DOM `.nav-file-title` visibility wait races under Xvfb and
    //    false-reds a vault that actually loaded fine.
    await waitForShadowVaultLoaded(shadowHandle.page, shadowLog, 30_000);

    // Best-effort: confirm the File Explorer DOM also painted. A miss
    // is annotated, not fatal — the model assertion already proved
    // the vault loaded; this only flags the headless paint lag.
    const fePainted = await shadowHandle.page
      .locator('.workspace-leaf-content[data-type="file-explorer"] .nav-file-title')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.info().annotations.push({
      type: fePainted ? 'fe-rendered' : 'fe-paint-lazy',
      description: fePainted
        ? 'File Explorer painted the remote tree'
        : 'vault model loaded; File Explorer DOM paint lagged (headless, non-fatal)',
    });
  });
});
