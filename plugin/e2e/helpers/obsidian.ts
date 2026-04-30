import { type Browser, type Page, chromium } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const CDP_PORT = Number(process.env.CDP_PORT ?? '9222');

/**
 * Resolve the Obsidian binary path.
 *
 * Priority:
 *   1. OBSIDIAN_PATH env var (CI / explicit override)
 *   2. Platform default install locations
 */
function resolveObsidianPath(): string {
  if (process.env.OBSIDIAN_PATH) return process.env.OBSIDIAN_PATH;

  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA ?? '',
        'Obsidian',
        'Obsidian.exe',
      );
    case 'darwin':
      return '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
    case 'linux':
      return '/usr/bin/obsidian';
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export interface ObsidianHandle {
  browser: Browser;
  page: Page;
  process: ChildProcess;
  cleanup: () => Promise<void>;
}

/**
 * Launch Obsidian with a specific vault and connect Playwright via CDP.
 *
 * The flow:
 *   1. Spawn the Obsidian binary with `--remote-debugging-port`
 *   2. Wait for the CDP endpoint to become available
 *   3. Connect Playwright via `chromium.connectOverCDP`
 *   4. Find the main Obsidian window page
 *
 * The returned `cleanup` function kills the process and disconnects.
 */
export async function launchObsidian(
  vaultPath: string,
): Promise<ObsidianHandle> {
  const obsidianBin = resolveObsidianPath();

  // Kill any existing Obsidian process so we get a clean instance
  // pointing at the scaffold vault instead of the user's last vault.
  await killExistingObsidian();

  // Register the scaffold vault in Obsidian's app config and mark
  // it as the only open vault so Obsidian opens it on launch.
  const restore = registerVault(vaultPath);

  const proc = spawn(obsidianBin, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-sandbox',
  ], {
    env: { ...process.env },
    stdio: 'pipe',
    detached: false,
  });

  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`;
  await waitForCDP(cdpUrl, 30_000);

  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  const page = contexts[0]?.pages()[0]
    ?? await contexts[0]?.newPage()
    ?? (() => { throw new Error('No Obsidian window found'); })();

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5_000);

  const cleanup = async () => {
    try { await browser.close(); } catch { /* best effort */ }
    if (!proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          resolve();
        }, 5_000);
        proc.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    restore();
  };

  return { browser, page, process: proc, cleanup };
}

/**
 * Kill any running Obsidian process. Obsidian is single-instance —
 * if one is already running, our spawn just signals the existing
 * process and exits, so we'd connect to the user's real vault
 * instead of the scaffold vault.
 */
async function killExistingObsidian(): Promise<void> {
  const { execSync } = await import('node:child_process');
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM Obsidian.exe /T', { stdio: 'ignore' });
    } else {
      execSync('pkill -f Obsidian || true', { stdio: 'ignore' });
    }
  } catch {
    // No existing process — fine
  }
  // Brief wait for the process to fully exit
  await new Promise((r) => setTimeout(r, 2_000));
}

/**
 * Register the scaffold vault in Obsidian's app config (`obsidian.json`)
 * and mark it as the only `open: true` vault so Obsidian opens it on
 * launch. Returns a restore function that puts back the original config.
 */
function registerVault(vaultPath: string): () => void {
  const configPath = path.join(
    process.env.APPDATA ?? path.join(process.env.HOME ?? '', '.config'),
    'obsidian',
    'obsidian.json',
  );

  let original: string | null = null;
  if (fs.existsSync(configPath)) {
    original = fs.readFileSync(configPath, 'utf8');
  }

  const config = original ? JSON.parse(original) : { vaults: {} };

  // Unset open on all existing vaults
  for (const id of Object.keys(config.vaults ?? {})) {
    delete config.vaults[id].open;
  }

  // Add scaffold vault as open
  const vaultId = crypto.randomBytes(8).toString('hex');
  config.vaults[vaultId] = {
    path: vaultPath.replace(/\//g, '\\'),
    ts: Date.now(),
    open: true,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return () => {
    // Restore original config
    if (original) {
      fs.writeFileSync(configPath, original, 'utf8');
    } else {
      // Remove the vault we added
      delete config.vaults[vaultId];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    }
  };
}

async function waitForCDP(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let delay = 500;

  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${url}/json/version`);
      if (resp.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3_000);
  }
  throw new Error(`CDP endpoint at ${url} did not become ready within ${timeoutMs}ms`);
}
