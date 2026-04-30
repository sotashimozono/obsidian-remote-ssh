import { defineConfig } from '@playwright/test';

/**
 * Playwright config for Obsidian E2E smoke tests.
 *
 * Obsidian is an Electron app — we can't use `_electron.launch()`
 * because Obsidian bundles its own Electron and its entry point
 * isn't a bare `main.js`. Instead, the test helper launches the
 * Obsidian binary directly with `--remote-debugging-port` and
 * Playwright connects via CDP (`browserType.connectOverCDP`).
 *
 * Env vars consumed by helpers:
 *   OBSIDIAN_PATH  — path to the Obsidian binary / AppImage
 *   TEST_VAULT     — path to the pre-scaffolded test vault
 *   CDP_PORT       — debugging port (default: 9222)
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  retries: 1,
  workers: 1, // Obsidian is a single-instance app
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../e2e-results' }],
  ],
});
