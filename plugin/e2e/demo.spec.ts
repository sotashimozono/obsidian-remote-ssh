import { test } from '@playwright/test';
import { launchObsidian, type ObsidianHandle } from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import * as path from 'node:path';

/**
 * Demo capture — takes annotated screenshots at key moments of the
 * plugin workflow for use in the README. Not a real test; just a
 * scripted walkthrough that captures visuals.
 *
 * Run: OBSIDIAN_PATH="..." npx playwright test --config e2e/playwright.config.ts demo.spec.ts
 *
 * Output: e2e/demo-screenshots/*.png
 */

const SCREENSHOTS = path.resolve(__dirname, 'demo-screenshots');

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

test('capture demo screenshots', async () => {
  const { page } = obsidian;

  // 1. Vault loaded
  await page.waitForTimeout(2_000);
  await page.screenshot({
    path: path.join(SCREENSHOTS, '01-vault-loaded.png'),
    fullPage: true,
  });

  // 2. Open settings → Remote SSH tab
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(1_500);
  const settingsModal = page.locator('.modal-container');
  const pluginTab = settingsModal.locator(
    '.vertical-tab-nav-item:has-text("Remote SSH")',
  );
  if (await pluginTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await pluginTab.click();
    await page.waitForTimeout(1_000);
  }
  await page.screenshot({
    path: path.join(SCREENSHOTS, '02-settings-tab.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 3. Command palette with Remote SSH commands
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Remote SSH');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(SCREENSHOTS, '03-command-palette.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 4. Trigger connect
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Remote SSH: Connect');
  await page.waitForTimeout(500);
  const cmd = page.locator('.prompt .suggestion-item').first();
  await cmd.click();
  await page.waitForTimeout(2_000);
  await page.screenshot({
    path: path.join(SCREENSHOTS, '04-connecting.png'),
    fullPage: true,
  });

  // 5. After connection attempt (profile picker or notice)
  await page.waitForTimeout(5_000);
  await page.screenshot({
    path: path.join(SCREENSHOTS, '05-connected.png'),
    fullPage: true,
  });
});
