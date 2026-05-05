import { test, expect } from '@playwright/test';
import {
  launchObsidian,
  connectAndOpenShadow,
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
    await page.keyboard.press('Control+,');
    const settingsModal = page.locator('.modal-container');
    await expect(settingsModal).toBeVisible({ timeout: 10_000 });

    const pluginTab = settingsModal
      .locator('.vertical-tab-nav-item:has-text("Remote SSH")')
      .first();
    await expect(pluginTab).toBeVisible({ timeout: 5_000 });

    // Close settings so subsequent tests start from a clean state.
    await page.keyboard.press('Escape');
    await expect(settingsModal).toBeHidden({ timeout: 5_000 });
  });

  test('3 — command palette shows Remote SSH commands', async () => {
    const { page } = obsidian;

    // Open command palette
    await page.keyboard.press('Control+P');
    await page.waitForTimeout(500);

    const palette = page.locator('.prompt');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Type to filter for our commands
    await page.keyboard.type('Remote SSH');
    await page.waitForTimeout(500);

    // Check that at least one command appears
    const suggestions = palette.locator('.suggestion-item');
    const count = await suggestions.count();

    // Close palette
    await page.keyboard.press('Escape');

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
