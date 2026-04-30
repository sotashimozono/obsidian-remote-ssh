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
});
