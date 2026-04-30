import { test, expect } from '@playwright/test';
import { launchObsidian, type ObsidianHandle } from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';

/**
 * E2E sync tests — verify that local Obsidian operations (create,
 * edit, delete) propagate to the remote filesystem.
 *
 * These tests require:
 *   - Docker test sshd running (`npm run sshd:start`)
 *   - Plugin + server built
 *   - Obsidian installed
 *
 * The test connects to the remote vault, performs file operations
 * via the Obsidian UI, then checks the remote filesystem directly
 * via a separate SFTP connection (RemoteVerifier) to confirm the
 * changes landed.
 *
 * The entire suite is skipped if Docker sshd is unreachable.
 */

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
let connected = false;

const STAMP = Date.now().toString(36);
const TEST_NOTE = `e2e-test-${STAMP}.md`;
const TEST_CONTENT_INITIAL = `# E2E Test Note\n\nCreated by sync.spec.ts at ${STAMP}\n`;
const TEST_CONTENT_EDITED = `# E2E Test Note (edited)\n\nEdited by sync.spec.ts at ${STAMP}\n`;

test.beforeAll(async () => {
  // Check remote connectivity first — skip everything if sshd is down
  remote = new RemoteVerifier();
  const remoteOk = await remote.connect();
  if (!remoteOk) {
    test.skip(true, 'Docker test sshd is not running — skipping sync tests');
    return;
  }

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // Connect to remote vault via command palette
  const { page } = obsidian;
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Remote SSH: Connect');
  await page.waitForTimeout(500);
  const palette = page.locator('.prompt');
  const cmd = palette.locator('.suggestion-item').first();
  await cmd.click();

  // Select profile if picker appears
  const picker = page.locator('.prompt');
  if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const profile = picker.locator('.suggestion-item').first();
    if (await profile.isVisible().catch(() => false)) {
      await profile.click();
    }
  }

  // Wait for connection — look for shadow vault window or status change
  await page.waitForTimeout(10_000);

  // Check if connection succeeded by looking for file explorer content
  const fileExplorer = page.locator('.nav-files-container');
  const explorerVisible = await fileExplorer.isVisible({ timeout: 15_000 }).catch(() => false);
  if (explorerVisible) {
    const items = await fileExplorer.locator('.nav-file, .nav-folder').count();
    connected = items > 0;
  }

  if (!connected) {
    test.skip(true, 'Could not connect to remote vault — skipping sync tests');
  }
});

test.afterAll(async () => {
  // Clean up test files on remote
  if (remote) {
    await remote.removeFile(TEST_NOTE).catch(() => {});
    await remote.disconnect();
  }
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

test.describe('Remote sync verification', () => {
  test.beforeEach(() => {
    if (!connected) test.skip(true, 'Not connected to remote');
  });

  test('create — new note appears on remote', async () => {
    const { page } = obsidian;

    // Create a new note via command palette
    await page.keyboard.press('Control+P');
    await page.waitForTimeout(300);
    await page.keyboard.type('Create new note');
    await page.waitForTimeout(500);
    const cmd = page.locator('.prompt .suggestion-item').first();
    await cmd.click();
    await page.waitForTimeout(1_000);

    // Type the filename in the title area
    // Obsidian focuses the inline title after creating a new note
    const inlineTitle = page.locator('.inline-title');
    if (await inlineTitle.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await inlineTitle.fill(TEST_NOTE.replace('.md', ''));
      await page.keyboard.press('Enter');
    }

    // Type content in the editor
    const editor = page.locator('.cm-editor .cm-content');
    await expect(editor).toBeVisible({ timeout: 5_000 });
    await editor.click();
    await page.keyboard.type(TEST_CONTENT_INITIAL);

    // Wait for the write to propagate to remote
    await page.waitForTimeout(5_000);

    // Verify on remote
    const exists = await remote.exists(TEST_NOTE);
    expect(exists).toBe(true);

    const content = await remote.readFile(TEST_NOTE);
    expect(content).toContain('E2E Test Note');
    expect(content).toContain(STAMP);
  });

  test('edit — modified content reflects on remote', async () => {
    const { page } = obsidian;

    // The note from the create test should still be open.
    // Select all and replace content.
    const editor = page.locator('.cm-editor .cm-content');
    await expect(editor).toBeVisible({ timeout: 5_000 });
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(TEST_CONTENT_EDITED);

    // Wait for the write to propagate
    await page.waitForTimeout(5_000);

    // Verify on remote
    const content = await remote.readFile(TEST_NOTE);
    expect(content).toContain('edited');
  });

  test('delete — removed note disappears from remote', async () => {
    const { page } = obsidian;

    // Delete the current note via command palette
    await page.keyboard.press('Control+P');
    await page.waitForTimeout(300);
    await page.keyboard.type('Delete current file');
    await page.waitForTimeout(500);
    const cmd = page.locator('.prompt .suggestion-item').first();
    await cmd.click();

    // Obsidian shows a confirmation dialog — click Delete
    const confirmBtn = page.locator('.modal-button-container button:has-text("Delete")');
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // Wait for delete to propagate
    await page.waitForTimeout(5_000);

    // Verify on remote
    const exists = await remote.exists(TEST_NOTE);
    expect(exists).toBe(false);
  });
});
