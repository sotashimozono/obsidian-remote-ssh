import { type Browser, type Page, chromium } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

const CDP_PORT = Number(process.env.CDP_PORT ?? '9222');

/**
 * Expand a leading `~/` (and bare `~`) to the user's home dir.
 * `child_process.spawn` does not perform shell expansion, so a literal
 * `~/foo` from an env var is taken verbatim and ENOENTs at exec time.
 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve the Obsidian binary path.
 *
 * Priority:
 *   1. OBSIDIAN_PATH env var (CI / explicit override)
 *   2. Platform default install locations
 */
function resolveObsidianPath(): string {
  if (process.env.OBSIDIAN_PATH) return expandHome(process.env.OBSIDIAN_PATH);

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

  const browser = await connectOverCDPWithRetry(cdpUrl);
  const contexts = browser.contexts();
  const page = contexts[0]?.pages()[0]
    ?? await contexts[0]?.newPage()
    ?? (() => { throw new Error('No Obsidian window found'); })();

  await page.waitForLoadState('domcontentloaded');
  await waitForObsidianReady(page, 30_000);

  // Obsidian opens new vaults in Restricted Mode — community plugins
  // listed in `community-plugins.json` are NOT loaded until the user
  // (or, here, the test harness) flips the global "community plugins"
  // toggle and trusts the vault. We do that via the in-renderer
  // `app.plugins` API rather than UI-driving Settings (the toggle's
  // DOM shape is unstable across Obsidian versions). Then block until
  // the plugin's instance is up AND at least one of its commands has
  // registered — without this guard the suite was running against an
  // empty Obsidian and every assertion downstream was meaningless.
  await ensurePluginLoaded(page, 'remote-ssh');
  await waitForPluginLoaded(page, 'remote-ssh', 30_000);

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
  } else {
    // First-launch CI runners (and any environment where Obsidian has
    // never been started) won't have ~/.config/obsidian/ yet, and
    // writeFileSync does not auto-create parent directories.
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  const config = original ? JSON.parse(original) : { vaults: {} };

  // Unset open on all existing vaults
  for (const id of Object.keys(config.vaults ?? {})) {
    delete config.vaults[id].open;
  }

  // Add scaffold vault as open
  const vaultId = crypto.randomBytes(8).toString('hex');
  config.vaults[vaultId] = {
    path: process.platform === 'win32' ? vaultPath.replace(/\//g, '\\') : vaultPath,
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

/**
 * Connect to Obsidian's CDP endpoint with retries.
 * Obsidian may take a moment to expose the endpoint after it starts.
 */
async function connectOverCDPWithRetry(
  cdpUrl: string,
  maxRetries = 10,
  intervalMs = 500,
): Promise<Browser> {
  let lastError: unknown;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await chromium.connectOverCDP(cdpUrl);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastError;
}

/**
 * Force Obsidian out of Restricted Mode and load the plugin via the
 * internal `app.plugins` API. Driving the Settings UI was unreliable
 * (button-text vs toggle-switch differs across Obsidian versions,
 * and `enabledPlugins.has(id)` returns true the moment the id is in
 * `community-plugins.json` — even when the actual plugin instance
 * never started).
 *
 * Calls (all idempotent):
 *   - `app.plugins.setEnable(true)`         -> turn the global toggle
 *                                              on; clears restricted mode
 *   - `app.plugins.enablePluginAndSave(id)` -> load the plugin and
 *                                              persist to community-plugins.json
 */
async function ensurePluginLoaded(page: Page, pluginId: string): Promise<void> {
  await page.evaluate(async (id) => {
    interface PluginsApi {
      setEnable?: (enable: boolean) => Promise<void> | void;
      enablePluginAndSave?: (id: string) => Promise<void>;
      enablePlugin?: (id: string) => Promise<void>;
      isEnabled?: () => boolean;
      plugins?: Record<string, unknown>;
    }
    const app = (globalThis as unknown as { app?: { plugins?: PluginsApi } }).app;
    const plugins = app?.plugins;
    if (!plugins) {
      throw new Error('app.plugins not available — Obsidian renderer not ready');
    }

    if (plugins.isEnabled && !plugins.isEnabled()) {
      await plugins.setEnable?.(true);
    }

    if (!plugins.plugins?.[id]) {
      // enablePluginAndSave is the public-ish path that updates
      // community-plugins.json too. Fall back to enablePlugin if the
      // method name has drifted across Obsidian versions.
      if (plugins.enablePluginAndSave) {
        await plugins.enablePluginAndSave(id);
      } else if (plugins.enablePlugin) {
        await plugins.enablePlugin(id);
      } else {
        throw new Error('app.plugins has no enablePlugin/enablePluginAndSave');
      }
    }
  }, pluginId);
}

/**
 * Block until the named plugin's instance is loaded AND at least one
 * of its namespaced commands has been registered. Throws after
 * `timeoutMs`. This is the canonical "the plugin actually started"
 * check.
 *
 * `enabledPlugins.has(id)` is NOT used here: that set tracks intent
 * (id present in community-plugins.json) and stays truthy even when
 * the plugin's onload threw and no commands ever registered.
 */
async function waitForPluginLoaded(
  page: Page,
  pluginId: string,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (id) => {
      interface AppShape {
        plugins?: { plugins?: Record<string, unknown> };
        commands?: { commands?: Record<string, unknown> };
      }
      const app = (globalThis as unknown as { app?: AppShape }).app;
      const instance = app?.plugins?.plugins?.[id];
      const cmds = app?.commands?.commands;
      if (!instance || !cmds) return false;
      // Any command whose id is namespaced to this plugin counts —
      // doesn't depend on a specific command name surviving a
      // refactor. Plugin command ids are `${pluginId}:${cmd}`.
      const prefix = `${id}:`;
      for (const key in cmds) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
    pluginId,
    { timeout: timeoutMs },
  );
}

/**
 * Poll for the Obsidian `.workspace` element instead of a fixed sleep.
 */
async function waitForObsidianReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator('.workspace').isVisible();
      if (visible) return;
    } catch {
      // page may not be ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Non-fatal: tests can still run even if workspace isn't visible
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
