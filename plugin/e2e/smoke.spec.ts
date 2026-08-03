import { test, expect } from '@playwright/test';
import {
  launchObsidian,
  connectAndOpenShadow,
  describePages,
  findPageWith,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';

/**
 * Obsidian E2E smoke tests — the bare-minimum correctness checks
 * that exercise a real Obsidian window connected to a remote vault
 * via the Docker test sshd.
 *
 * Prerequisites:
 *   - Obsidian installed (or OBSIDIAN_PATH set)
 *   - Docker test sshd running (`npm run sshd:start`)
 *   - Plugin built (`npm run build`)
 *   - Server built (`npm run build:server`)
 *
 * Run: `npx playwright test --config e2e/playwright.config.ts`
 */

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;

test.beforeAll(async () => {
  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

test.describe('Remote SSH E2E smoke', () => {
  test('1 — Obsidian window opens and loads the vault', async () => {
    const { page } = obsidian;

    // Obsidian's main workspace container should be present
    const workspace = page.locator('.workspace');
    await expect(workspace).toBeVisible({ timeout: 30_000 });
  });

  test('2 — plugin settings tab is accessible', async () => {
    const { page } = obsidian;

    // Open Settings (Ctrl+,) and assert the Remote SSH plugin tab
    // is reachable. The previous version of this test only
    // annotated when the tab was visible — it never failed, so a
    // missing tab would silently slip through.
    // Settings does not necessarily render in the window we press the
    // shortcut in — Obsidian gives it its own page, which is why this
    // assertion read "element(s) not found" for runs on end while the
    // dialog was plainly up (run 30773839148's `test-failed-2.png`).
    // Assert it is reachable, in whichever window Obsidian put it; that
    // is what "accessible" means to a user. Requiring it in one specific
    // page asserted a fact about the harness, not about the product.
    await page.keyboard.press('Control+,');
    const settingsPage = await findPageWith(page, '.modal-container', 10_000);
    expect(
      settingsPage,
      `Settings did not open in any Obsidian window.\n  windows: ${await describePages(page)}`,
    ).not.toBeNull();

    const settingsModal = settingsPage!.locator('.modal-container');
    const pluginTab = settingsModal
      .locator('.vertical-tab-nav-item:has-text("Remote SSH")')
      .first();
    await expect(pluginTab).toBeVisible({ timeout: 5_000 });

    // Close settings so subsequent tests start from a clean state.
    await settingsPage!.keyboard.press('Escape');
    await expect(settingsModal).toBeHidden({ timeout: 5_000 });
  });

  test('3 — command palette shows Remote SSH commands', async () => {
    const { page } = obsidian;

    // Open command palette — again, in whichever window it lands in.
    await page.keyboard.press('Control+P');
    const palettePage = await findPageWith(page, '.prompt', 10_000);
    expect(
      palettePage,
      `The command palette did not open in any Obsidian window.\n  windows: ${await describePages(page)}`,
    ).not.toBeNull();

    const palette = palettePage!.locator('.prompt');

    // Type to filter for our commands
    await palettePage!.keyboard.type('Remote SSH');
    await palettePage!.waitForTimeout(500);

    // Check that at least one command appears
    const suggestions = palette.locator('.suggestion-item');
    const count = await suggestions.count();

    // Close palette
    await palettePage!.keyboard.press('Escape');

    expect(count).toBeGreaterThan(0);
  });

  test('4 — connect to remote vault via command palette', async () => {
    // connectAndOpenShadow drives palette → "Remote SSH: Connect" →
    // passphrase modal Connect button → kill original → relaunch on
    // the shadow vault path Obsidian registered. After it returns,
    // `obsidian` points at the SHADOW window (the only one where
    // the connected status bar + remote files actually appear).
    obsidian = await connectAndOpenShadow(obsidian, scaffold.vaultPath);

    // The shadow vault's status bar must report the live connection.
    // This is the assertion the previous test 4 was missing — it
    // relied on "any .notice is visible" which fired even on
    // connection FAILURES (the failure notice itself is a .notice).
    const statusBar = obsidian.page.locator('.status-bar');
    await expect(statusBar).toContainText('Remote SSH: Connected', {
      timeout: 30_000,
    });
  });

  test('5 — file explorer shows remote files after connect', async () => {
    // Test 4 left `obsidian` attached to the shadow vault. The
    // file explorer there should list the docker test sshd's
    // pre-seeded `remote_demo*.md` (5 files).
    const fileExplorer = obsidian.page.locator('.nav-files-container');
    await expect(fileExplorer).toBeVisible({ timeout: 10_000 });

    // Anchor on the actual remote filenames rather than just
    // "items > 0" — the previous count-only assertion passed on
    // any vault that had at least one local file, including the
    // scaffold's seeded local_demo*.md, and didn't actually verify
    // a remote sync had happened.
    for (const i of [1, 2, 3, 4, 5]) {
      await expect(
        obsidian.page.locator(`.nav-file-title[data-path$="remote_demo${i}.md"]`),
      ).toBeVisible({ timeout: 15_000 });
    }
  });
});
