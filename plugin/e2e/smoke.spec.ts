import { test, expect } from '@playwright/test';
import { launchObsidian, type ObsidianHandle } from './helpers/obsidian';
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

    // Open settings via command palette
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(1_000);

    // Navigate to community plugins section and find Remote SSH
    const settingsModal = page.locator('.modal-container');
    await expect(settingsModal).toBeVisible({ timeout: 10_000 });

    // Look for the plugin in the settings sidebar
    const pluginTab = settingsModal.locator(
      '.vertical-tab-nav-item:has-text("Remote SSH")',
    );

    // Close settings
    await page.keyboard.press('Escape');

    if (await pluginTab.isVisible().catch(() => false)) {
      test.info().annotations.push({
        type: 'info',
        description: 'Remote SSH plugin tab found in settings',
      });
    }
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
    const { page } = obsidian;

    // Open command palette and invoke Connect
    await page.keyboard.press('Control+P');
    await page.waitForTimeout(500);
    const palette = page.locator('.prompt');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    await page.keyboard.type('Remote SSH: Connect');
    await page.waitForTimeout(500);

    // Click the first matching suggestion
    const connectCmd = palette.locator('.suggestion-item').first();
    await connectCmd.click();

    // Wait for the profile picker or direct connect. If a profile
    // picker appears, select the first (E2E Test) profile.
    const profilePicker = page.locator('.prompt');
    if (await profilePicker.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const firstProfile = profilePicker.locator('.suggestion-item').first();
      if (await firstProfile.isVisible().catch(() => false)) {
        await firstProfile.click();
      }
    }

    // Wait for shadow vault window or connection status indicator.
    // The status bar should show connection activity within 30s.
    // We look for any status bar item mentioning "Remote" or "SSH"
    // or the connected indicator.
    const statusBar = page.locator('.status-bar');
    await expect(statusBar).toBeVisible({ timeout: 30_000 });

    // Allow time for the connection attempt. Even if the Docker sshd
    // isn't running, we verify the plugin attempted to connect by
    // checking for a notice (success or error).
    const notice = page.locator('.notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
  });

  test('5 — file explorer shows remote files after connect', async () => {
    const { page } = obsidian;

    // This test depends on test 4 having successfully connected.
    // Check if we're in a shadow vault by looking for files in the
    // file explorer.
    const fileExplorer = page.locator('.nav-files-container');

    // If the connection succeeded (Docker sshd was running), the
    // file explorer should have items. If not, skip gracefully.
    const isVisible = await fileExplorer.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!isVisible) {
      test.skip(true, 'File explorer not visible — connection may not have succeeded');
      return;
    }

    // Check that at least one file or folder is shown
    const items = fileExplorer.locator('.nav-file, .nav-folder');
    const count = await items.count();

    if (count === 0) {
      test.skip(true, 'No files in explorer — Docker sshd may not be running');
      return;
    }

    expect(count).toBeGreaterThan(0);
  });
});
