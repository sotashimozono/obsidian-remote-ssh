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
 * Drive the per-profile connect flow on `handle.page` end-to-end and
 * return a NEW handle attached to the shadow vault Obsidian opens
 * for the connected profile.
 *
 * The shadow vault is a separate Electron process that doesn't
 * inherit our `--remote-debugging-port`, so Playwright can't see it
 * over the existing CDP connection. Workaround mirrors what the
 * demo spec already does: read the new entry in
 * `~/.config/obsidian/obsidian.json` (the one whose path isn't the
 * scaffold's), tear down the original handle, then `launchObsidian`
 * ourselves on the shadow vault path. Plugin auto-connect on first
 * open populates the file explorer with the remote files.
 *
 * The connect flow itself drives the UI:
 *   1. Ctrl+P → palette opens
 *   2. type "Remote SSH: Connect" → "Connect to remote vault" highlighted
 *   3. Enter → per-profile passphrase modal opens
 *   4. click `Connect` button → SSH handshake fires (Enter in the
 *      empty passphrase input does NOT submit; verified empirically)
 *
 * Throws if no shadow vault entry shows up in obsidian.json within
 * 15 s — that's the canonical "connect didn't actually run" signal.
 */
export async function connectAndOpenShadow(
  handle: ObsidianHandle,
  scaffoldVaultPath: string,
): Promise<ObsidianHandle> {
  const { page } = handle;

  // Drive the connect command via the palette.
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Remote SSH: Connect', { delay: 25 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_200);

  // Click the Connect button on the passphrase modal. Pressing
  // Enter in the empty passphrase input doesn't submit — only the
  // explicit button click kicks off the SSH handshake.
  const connectBtn = page.locator('.modal button:has-text("Connect")').first();
  if (await connectBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await connectBtn.click();
  }

  // Poll obsidian.json until the shadow vault entry appears (the
  // plugin registers the new path in the global vaults map before
  // firing `obsidian://open?path=`). Don't just sleep a fixed time —
  // boot variance + handshake latency makes that flaky.
  const obsidianConfigPath = path.join(
    process.env.APPDATA ?? path.join(process.env.HOME ?? '', '.config'),
    'obsidian',
    'obsidian.json',
  );
  const deadline = Date.now() + 15_000;
  let shadowVaultPath: string | null = null;
  while (Date.now() < deadline) {
    try {
      const cfg = JSON.parse(fs.readFileSync(obsidianConfigPath, 'utf8')) as {
        vaults?: Record<string, { path?: string; ts?: number }>;
      };
      // obsidian.json accumulates entries across spec files (it's
      // the user-global config). After demo.spec.ts runs, this map
      // can hold a stale entry for the deleted demo scaffold AND
      // the shadow vault from that demo. "First non-scaffold
      // entry" risks returning the deleted scaffold and crashing
      // launchObsidian downstream. Filter to entries that (a)
      // aren't this spec's scaffold, (b) actually exist on disk,
      // and (c) pick the most recently registered (highest `ts`)
      // so we land on the freshly-opened shadow vault rather than
      // a leftover.
      let bestTs = -1;
      for (const id of Object.keys(cfg.vaults ?? {})) {
        const entry = cfg.vaults?.[id];
        const entryPath = entry?.path;
        if (!entryPath || entryPath === scaffoldVaultPath) continue;
        if (!fs.existsSync(entryPath)) continue;
        const ts = entry?.ts ?? 0;
        if (ts > bestTs) {
          bestTs = ts;
          shadowVaultPath = entryPath;
        }
      }
    } catch {
      // file may be mid-write; retry
    }
    if (shadowVaultPath) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!shadowVaultPath) {
    throw new Error(
      'connectAndOpenShadow: no shadow vault entry appeared in obsidian.json ' +
      'within 15 s — connect command likely never fired',
    );
  }

  // Hand off to a fresh Obsidian instance on the shadow vault path
  // so Playwright/CDP attaches to the connected window directly.
  await handle.cleanup();
  return launchObsidian(shadowVaultPath);
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
 * Click "Trust author and enable plugins" if Obsidian's per-vault
 * trust dialog is blocking the workspace. This must be done BEFORE
 * any test fires keyboard shortcuts — Obsidian's modal swallows
 * Ctrl+P / Ctrl+, while it's open, which is exactly what was
 * silently breaking every spec downstream. Returns whether the
 * button was actually clicked (informational; both branches are
 * safe to ignore).
 */
async function dismissTrustDialog(page: Page): Promise<boolean> {
  // Obsidian renders the trust dialog inside a `.modal` container
  // with two buttons. We anchor on the affirmative button text
  // because it's far less likely to drift than DOM structure.
  const trustBtn = page
    .locator('button:has-text("Trust author and enable plugins")')
    .first();
  if (!await trustBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
    return false;
  }
  await trustBtn.click();
  // Wait for the modal to actually disappear before continuing —
  // a stale modal blocks the next keyboard shortcut even if the
  // button click "succeeded".
  await trustBtn.waitFor({ state: 'detached', timeout: 8_000 }).catch(() => {});
  return true;
}

/**
 * Force Obsidian out of Restricted Mode and load the plugin. First
 * dismiss the trust dialog if it's blocking the UI (clicking
 * "Trust author and enable plugins" is what Obsidian itself does to
 * flip restricted mode off + load community-plugins.json). Then call
 * the `app.plugins` API as a safety net for paths where the dialog
 * never appeared (e.g., Obsidian build that auto-trusts pre-config'd
 * vaults).
 *
 * Idempotent: safe to call on a vault that's already trusted; both
 * the dialog dismissal and the API call no-op if their precondition
 * is already met.
 */
async function ensurePluginLoaded(page: Page, pluginId: string): Promise<void> {
  await dismissTrustDialog(page);

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
