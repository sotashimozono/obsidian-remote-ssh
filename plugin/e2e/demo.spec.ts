import { test } from '@playwright/test';
import { launchObsidian, type ObsidianHandle } from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { ScreenRecorder } from './helpers/screen-recorder';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Demo capture — records an animated GIF of the plugin workflow
 * for use in the README. Not a real test; just a scripted
 * walkthrough that captures visuals.
 *
 * Run:
 *   OBSIDIAN_PATH="..." npx playwright test --config e2e/playwright.config.ts demo.spec.ts
 *
 * Output: e2e/demo-screenshots/demo.gif
 */

const OUTPUT_DIR = path.resolve(__dirname, 'demo-screenshots');

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;

test.beforeAll(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

test('record demo GIF', async () => {
  const { page } = obsidian;
  const recorder = new ScreenRecorder();

  // Dismiss Safe Mode / trust dialog if it appears
  const trustBtn = page.locator('button:has-text("信頼"), button:has-text("Trust")').first();
  if (await trustBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await trustBtn.click();
    await page.waitForTimeout(2_000);
  }

  // If Restricted Mode banner appears, click "有効化" / "Enable" to
  // turn on community plugins, then close the settings modal.
  const enableBtn = page.locator('button:has-text("有効化"), button:has-text("Enable")').first();
  if (await enableBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await enableBtn.click();
    await page.waitForTimeout(2_000);
  }

  // Close any open modal (settings) so the vault is visible
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_500);

  // Ensure left sidebar (file explorer) is visible
  const sidebar = page.locator('.workspace-split.mod-left-split');
  const sidebarCollapsed = await sidebar.evaluate(
    (el) => el.classList.contains('is-collapsed'),
  ).catch(() => true);
  if (sidebarCollapsed) {
    // Toggle left sidebar via hotkey
    await page.keyboard.press('Control+Shift+E');
    await page.waitForTimeout(1_000);
  }

  // Click on welcome_local.md if visible to show content
  const welcomeFile = page.locator('.nav-file-title:has-text("welcome_local")');
  if (await welcomeFile.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await welcomeFile.click();
    await page.waitForTimeout(1_000);
  }

  // Start recording at ~5 fps
  await recorder.start(page, 200);

  // 1. Show the vault loaded with local files
  await page.waitForTimeout(3_000);

  // 2. Open settings → Remote SSH tab
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(1_500);
  const settingsModal = page.locator('.modal-container');
  const pluginTab = settingsModal.locator(
    '.vertical-tab-nav-item:has-text("Remote SSH")',
  );
  if (await pluginTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await pluginTab.click();
    await page.waitForTimeout(2_000);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_000);

  // 3. Command palette with Remote SSH commands
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Remote SSH', { delay: 50 });
  await page.waitForTimeout(1_500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_000);

  // 4. Trigger connect
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Remote SSH: Connect', { delay: 50 });
  await page.waitForTimeout(1_000);
  const cmd = page.locator('.prompt .suggestion-item').first();
  if (await cmd.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await cmd.click();
  }
  await page.waitForTimeout(3_000);

  // 5. Final state
  await page.waitForTimeout(2_000);

  // Save the recording
  await recorder.save(path.join(OUTPUT_DIR, 'demo.gif'), 200);

  console.log(`Demo GIF saved: ${path.join(OUTPUT_DIR, 'demo.gif')} (${recorder.frameCount} frames)`);
});
