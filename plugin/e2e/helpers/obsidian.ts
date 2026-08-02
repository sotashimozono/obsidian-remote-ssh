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

  // `dismissTrustDialog` (inside ensurePluginLoaded) clicks "Trust author and
  // enable plugins", and Obsidian's own reaction is to OPEN ITS SETTINGS
  // DIALOG on the Community-plugins tab. That is a `.modal-container.mod-dim`
  // full-window overlay, and Playwright cannot click through it: every later
  // File-Explorer / editor click dies with "...intercepts pointer events".
  //
  // The suite has been running under that overlay in every window since the
  // trust-dismiss path was added. It went unnoticed because model-level probes
  // (page.evaluate over vault/metadataCache) and Node-side fetches are immune —
  // so only click-driven tests were affected, and those just hung. `demo.spec`
  // is the one place that ever knew (it presses Esc, with a comment saying
  // exactly this); every other spec simply ate it.
  //
  // Close it here, once, for every spec. It logs whatever it closed, so a modal
  // that IS meaningful (a host-key prompt, PendingPluginsModal) surfaces in the
  // CI log instead of being silently swallowed.
  await dismissBlockingModals(page);

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
 * Drive the per-profile connect flow on `page` up to (and including)
 * clicking the passphrase modal's `Connect` button. Does NOT wait
 * for the shadow vault to materialise — the caller decides when to
 * poll for it (so demo.spec.ts can keep its screencast running while
 * the UI handshake happens).
 *
 * Steps:
 *   1. Ctrl+P → palette opens
 *   2. type "Remote SSH: Connect" → "Connect to remote vault" highlighted
 *   3. Enter → per-profile passphrase modal opens
 *   4. click `Connect` button → SSH handshake fires (Enter in the
 *      empty passphrase input does NOT submit; verified empirically)
 */
export async function driveConnectFlow(page: Page): Promise<void> {
  // CI's headless Obsidian is slow/racy to wire the command palette
  // for ~seconds after the plugin loads (proven: the pre-existing
  // smoke "settings tab" test fails first try, passes on retry). The
  // old fixed `waitForTimeout`s raced that window — Ctrl+P / Enter
  // landed before the palette accepted input, so the connect command
  // never fired and the connect-lifecycle/reconnect specs hard-failed
  // with "connect command likely never fired". Wait for the palette
  // input to actually be present before typing; re-open it if the
  // first Ctrl+P didn't take.
  const paletteInput = page
    .locator('.prompt input, input.prompt-input, .suggestion-container input')
    .first();

  // Fire the command through Obsidian's own command registry first.
  //
  // Keyboard-driving the palette is the single largest source of red in
  // this suite — "command palette never opened (Obsidian not
  // interactive)" is most of the failures on a typical CI run — and it
  // is never a product fault: under Xvfb the window can be up and
  // painting while keyboard input still goes nowhere, and five Ctrl+P
  // retries over 20 s do not outlast that. `executeCommandById` needs
  // no focus, no keyboard and no fuzzy match, so what these specs are
  // actually about — does connect work — stops depending on whether a
  // headless window felt like accepting a keystroke.
  //
  // The palette is not left untested: `smoke.spec.ts` drives it
  // directly, and the fallback below still runs whenever the command
  // registry is unreachable.
  // Wait for the command to EXIST before trying to run it.
  //
  // This is what the old flow got wrong, and what the palette hid: a
  // connect driven before `onload` finished registering commands has
  // nothing to run. Through the palette that failure is SILENT — typing
  // a command name that is not there still leaves some other suggestion
  // highlighted, so Enter runs that instead, no shadow vault appears,
  // and the error the spec eventually reports is "connect command
  // likely never fired" with no hint as to why.
  const registered = await page
    .waitForFunction(
      () => {
        const registry = (window as unknown as {
          app?: { commands?: { commands?: Record<string, unknown> } };
        }).app?.commands?.commands;
        return Boolean(registry)
          && Object.keys(registry as Record<string, unknown>).some(k => k.endsWith('remote-ssh:connect'));
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);

  if (!registered) {
    // Name which of the two things went wrong, with the evidence.
    const diag = await page.evaluate(() => {
      const w = window as unknown as {
        app?: {
          plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> };
          commands?: { commands?: Record<string, unknown> };
        };
      };
      return {
        loadedPlugins: Object.keys(w.app?.plugins?.plugins ?? {}),
        enabledPlugins: [...(w.app?.plugins?.enabledPlugins ?? [])],
        commandCount: Object.keys(w.app?.commands?.commands ?? {}).length,
      };
    }).catch(() => null);
    throw new Error(
      'driveConnectFlow: remote-ssh:connect never appeared in Obsidian\'s command registry '
      + `within 30s — the plugin did not load. ${JSON.stringify(diag)}`,
    );
  }

  const firedId = await page.evaluate(() => {
    const app = (window as unknown as {
      app?: {
        commands?: {
          commands?: Record<string, unknown>;
          executeCommandById?: (id: string) => boolean;
        };
      };
    }).app;
    const registry = app?.commands;
    if (!registry?.executeCommandById || !registry.commands) return null;
    // The plugin registers `connect`; Obsidian namespaces it by plugin id.
    const id = Object.keys(registry.commands).find(k => k.endsWith('remote-ssh:connect'));
    if (!id) return null;
    return registry.executeCommandById(id) ? id : null;
  });

  if (firedId === null) {
    let opened = false;
    for (let i = 0; i < 5 && !opened; i++) {
      await page.keyboard.press('Control+P');
      opened = await paletteInput
        .waitFor({ state: 'visible', timeout: 4_000 })
        .then(() => true)
        .catch(() => false);
      if (!opened) await page.keyboard.press('Escape').catch(() => { /* ignore */ });
    }
    if (!opened) {
      throw new Error(
        'driveConnectFlow: remote-ssh:connect was not in Obsidian\'s command registry ' +
        '(is the plugin loaded?) and the command palette never opened either — ' +
        'Obsidian is not interactive',
      );
    }

    await paletteInput.fill('');
    await page.keyboard.type('Remote SSH: Connect', { delay: 20 });
    // Let the fuzzy filter settle on the matching command.
    await page.waitForTimeout(600);
    await page.keyboard.press('Enter');
  }

  // The per-profile connect modal appears for passphrase/confirm
  // profiles; for the scaffold's key-auth profile connect can fire
  // straight off Enter (no modal). Click the button if it shows; its
  // absence is not an error.
  const connectBtn = page.locator('.modal button:has-text("Connect")').first();
  if (await connectBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await connectBtn.click();
  }
}

/**
 * Robust connect: drive the palette flow, then wait for the shadow
 * vault to register. If it doesn't appear within a per-attempt
 * window, re-drive the connect command (CI Obsidian may not have been
 * interactive on the first attempt) — bounded by `timeoutMs`.
 *
 * Re-driving is safe: a successful (if slow) first spawn is guarded
 * by the plugin's `shadowSpawnInFlight` debounce (a second connect
 * within ~15s is a no-op), and that slow spawn's entry still shows up
 * for a later poll; a first attempt that never fired left no guard,
 * so the retry fires cleanly.
 */
export async function connectAndWaitForShadowVault(
  page: Page,
  scaffoldVaultPath: string,
  timeoutMs = 45_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    attempts++;
    try {
      await driveConnectFlow(page);
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1_500);
      continue;
    }
    const perAttempt = Math.min(15_000, Math.max(3_000, deadline - Date.now()));
    try {
      return await findShadowVaultPath(scaffoldVaultPath, perAttempt);
    } catch (e) {
      lastErr = e; // not registered yet — re-drive the connect command
    }
  }
  throw new Error(
    `connectAndWaitForShadowVault: no shadow vault after ${attempts} connect ` +
    `attempt(s) in ${timeoutMs}ms — ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * Poll Obsidian's user-global config for the shadow vault entry the
 * plugin registers when a connect command fires. Returns the on-disk
 * path. Throws if no eligible entry shows up within `timeoutMs` —
 * that's the canonical "connect didn't actually run" signal.
 *
 * `obsidian.json` accumulates entries across spec files (it's
 * user-global), so the picker filters to entries whose path
 * (a) isn't this spec's scaffold, (b) actually exists on disk, and
 * (c) picks the most recently registered (highest `ts`).
 */
export async function findShadowVaultPath(
  scaffoldVaultPath: string,
  timeoutMs: number,
): Promise<string> {
  const obsidianConfigPath = path.join(
    process.env.APPDATA ?? path.join(process.env.HOME ?? '', '.config'),
    'obsidian',
    'obsidian.json',
  );
  const deadline = Date.now() + timeoutMs;
  let shadowVaultPath: string | null = null;
  while (Date.now() < deadline) {
    try {
      const cfg = JSON.parse(fs.readFileSync(obsidianConfigPath, 'utf8')) as {
        vaults?: Record<string, { path?: string; ts?: number }>;
      };
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
    if (shadowVaultPath) return shadowVaultPath;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `findShadowVaultPath: no shadow vault entry appeared in obsidian.json ` +
    `within ${timeoutMs} ms — connect command likely never fired`,
  );
}

/**
 * Drive the per-profile connect flow on `handle.page` end-to-end and
 * return a NEW handle attached to the shadow vault Obsidian opens
 * for the connected profile.
 *
 * Composes `driveConnectFlow` (UI) + `findShadowVaultPath` (config
 * polling) so callers that want a different lifecycle (the demo
 * spec wraps the UI part in a screencast) can use those building
 * blocks directly.
 *
 * Throws if no shadow vault entry shows up in obsidian.json within
 * 15 s — propagated from `findShadowVaultPath`.
 */
export async function connectAndOpenShadow(
  handle: ObsidianHandle,
  scaffoldVaultPath: string,
): Promise<ObsidianHandle> {
  await driveConnectFlow(handle.page);
  const shadowVaultPath = await findShadowVaultPath(scaffoldVaultPath, 15_000);

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
 * Close any Obsidian modal that is covering the workspace, and report how many
 * were closed.
 *
 * WHY THIS EXISTS (it is a HARNESS concern, not a product assertion)
 * -----------------------------------------------------------------
 * `launchObsidian` → `ensurePluginLoaded` → `dismissTrustDialog` clicks
 * "Trust author and enable plugins". Obsidian's own response to that gesture is
 * to OPEN ITS SETTINGS DIALOG on the Community-plugins tab — `demo.spec.ts:131`
 * has known this for as long as it has existed ("Esc closes the Settings panel
 * auto-opened by the trust-dismiss path") and was the only spec that ever acted
 * on it. That dialog is a `.modal-container.mod-dim`: a full-viewport overlay
 * that INTERCEPTS POINTER EVENTS for the whole window. Every subsequent
 * `click()` on a File Explorer row or an editor link is then un-actionable, and
 * Playwright reports it as
 *
 *     <div data-setting-id="plugins" class="vertical-tab-nav-item"> from
 *     <div class="modal-container mod-dim"> subtree intercepts pointer events
 *
 * — i.e. the element the test wanted is visible, enabled and stable, and the
 * click still cannot land. Model-level probes (`page.evaluate` over `vault` /
 * `metadataCache`) are unaffected, which is exactly why a spec can pass all of
 * its index assertions and fail only the ones that touch the UI.
 *
 * A covered element is not a product defect. Dismissing the overlay restores a
 * precondition the tests always assumed; it does not relax anything they assert.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not silently swallow product surfaces. Every modal it closes is
 * `console.warn`'d with its title, its active settings tab and its classes, so
 * a modal nobody expected (a `PendingPluginsModal`, a host-key prompt, a write
 * conflict) shows up in the CI log against the spec that hit it rather than
 * vanishing. If Escape does not close a modal, that is logged too and the loop
 * gives up rather than spinning — the click that follows then fails with
 * Playwright's own intercept diagnostic, which is the honest outcome.
 *
 * Do NOT call this while a palette / Quick Switcher is deliberately open —
 * those are `.modal-container`s too and Escape will close them. Call it BEFORE
 * an interaction sequence, never inside one.
 *
 * @returns how many modals were actually closed (0 when the workspace was clear).
 */
export async function dismissBlockingModals(
  page: Page,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let closed = 0;

  // Bounded: a handful of stacked modals is already pathological, and an
  // Escape-proof modal must fail LOUDLY rather than spin until the deadline.
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
    const open = await describeOpenModals(page);
    if (open.length === 0) break;

    console.warn(
      `[e2e] dismissBlockingModals: ${open.length} Obsidian modal(s) are covering ` +
      'the workspace and would intercept every click. Closing with Escape. ' +
      `Modal(s): ${JSON.stringify(open)}`,
    );
    await page.keyboard.press('Escape').catch(() => { /* best effort */ });

    // Obsidian tears modals down asynchronously; poll for the count to drop
    // rather than sleeping a fixed amount.
    const settleBy = Math.min(Date.now() + 3_000, deadline);
    let remaining = open.length;
    while (Date.now() < settleBy) {
      remaining = (await describeOpenModals(page)).length;
      if (remaining < open.length) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    if (remaining >= open.length) {
      console.warn(
        '[e2e] dismissBlockingModals: Escape did NOT close ' +
        `${JSON.stringify(open)} — it is not Escape-dismissable. Leaving it up.`,
      );
      break;
    }
    closed += open.length - remaining;
  }

  return closed;
}

/**
 * One identifying line per open `.modal-container`, for the warn above. The
 * title, the active settings tab (`data-setting-id` — the field that pins
 * Obsidian's own auto-opened Settings dialog as the culprit) and the classes
 * are enough to tell that dialog apart from a genuine product modal.
 */
async function describeOpenModals(page: Page): Promise<string[]> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('.modal-container')).map((c) => {
        const title = c.querySelector('.modal-title')?.textContent?.trim() ?? '';
        const activeTab = c
          .querySelector('.vertical-tab-nav-item.is-active')
          ?.getAttribute('data-setting-id') ?? '';
        const modal = c.querySelector('.modal');
        return JSON.stringify({
          title: title || '(untitled)',
          settingTab: activeTab || null,
          containerClass: c.className,
          modalClass: modal?.className ?? null,
        });
      }),
    )
    .catch(() => []);
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

/**
 * Run an Obsidian command through the command palette, robust to CI's
 * slow/racy palette wiring. The old per-spec pattern —
 * `Ctrl+P` → `waitForTimeout(300)` → type → `waitForTimeout(500)` →
 * click `.prompt .suggestion-item` — raced the palette: in CI the
 * suggestion list isn't populated yet when the fixed sleeps elapse,
 * so the click hangs and the whole test hits its 120s timeout (the
 * sync.spec create/edit/delete cascade in run 26015295742). Mirrors
 * `driveConnectFlow`'s hardened open: re-press until the palette
 * input is actually visible, then wait for a real suggestion to
 * appear before clicking it.
 */
export async function runCommandViaPalette(
  page: Page,
  query: string,
): Promise<void> {
  const paletteInput = page
    .locator('.prompt input, input.prompt-input, .suggestion-container input')
    .first();

  // Registry first, for the same reason as `driveConnectFlow`: the
  // caller wants the command to RUN, and a headless window that will
  // not take a keystroke should not be able to fail that. Matching is
  // on the command's display name, which is what `query` already is.
  const firedId = await page.evaluate((q) => {
    const app = (window as unknown as {
      app?: {
        commands?: {
          commands?: Record<string, { name?: string }>;
          executeCommandById?: (id: string) => boolean;
        };
      };
    }).app;
    const registry = app?.commands;
    if (!registry?.executeCommandById || !registry.commands) return null;
    const wanted = q.toLowerCase();
    const id = Object.entries(registry.commands)
      .find(([cid, cmd]) => (cmd?.name ?? '').toLowerCase().includes(wanted)
        || cid.toLowerCase().includes(wanted))?.[0];
    if (!id) return null;
    return registry.executeCommandById(id) ? id : null;
  }, query);
  if (firedId !== null) return;

  let opened = false;
  for (let i = 0; i < 5 && !opened; i++) {
    await page.keyboard.press('Control+P');
    opened = await paletteInput
      .waitFor({ state: 'visible', timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) await page.keyboard.press('Escape').catch(() => { /* ignore */ });
  }
  if (!opened) {
    throw new Error(
      `runCommandViaPalette: "${query}" was not in Obsidian's command registry and the ` +
      'command palette never opened either (Obsidian not interactive)',
    );
  }

  await paletteInput.fill('');
  await page.keyboard.type(query, { delay: 20 });

  // Wait for the fuzzy filter to actually surface a suggestion before
  // clicking — the fixed sleep this replaces is exactly what raced.
  const firstSuggestion = page.locator('.prompt .suggestion-item').first();
  await firstSuggestion.waitFor({ state: 'visible', timeout: 10_000 });
  await firstSuggestion.click();
}

/**
 * Expand a folder in the File Explorer and wait until its children are
 * actually IN the vault model.
 *
 * The remote tree is loaded lazily, one level per expand: connect only
 * materialises the root's immediate children, and every folder below
 * that is an initially-childless `TFolder` until it is opened
 * (`LazyFolderLoader`). The product's hook for that is a delegated
 * capture-phase click listener that reads
 * `target.closest('.nav-folder-title')` and its `data-path`
 * (`src/main.ts:923-924`) — so clicking exactly that element is not a UI
 * convenience here, it IS the trigger. Dispatching to any other node (or
 * calling an internal API) would test something the user cannot do.
 *
 * Waits on `vault.fileMap` rather than on rendered `.nav-file-title`
 * nodes, for the same reason `waitForShadowVaultLoaded` does: headless
 * Obsidian's File Explorer paint is lazy/virtualised under Xvfb and
 * races, while the model is what the load actually produces.
 */
export async function expandFolderInExplorer(
  page: Page,
  folderPath: string,
  timeoutMs = 20_000,
): Promise<void> {
  const title = page.locator(`.nav-folder-title[data-path="${folderPath}"]`).first();
  await title
    .waitFor({ state: 'attached', timeout: Math.min(timeoutMs, 10_000) })
    .catch(() => { /* absent title IS the finding — reported below */ });

  if (await title.count() === 0) {
    throw new Error(
      `expandFolderInExplorer: no .nav-folder-title[data-path="${folderPath}"] in the ` +
      'File Explorer — the folder was never materialised by the connect populate, ' +
      `so there is nothing to expand.\n${await dumpFolderState(page, folderPath)}`,
    );
  }

  await title.click();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await countChildrenInFileMap(page, folderPath) >= 1) return;
    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error(
    `expandFolderInExplorer: "${folderPath}" still had no children in vault.fileMap ` +
    `within ${timeoutMs}ms of clicking its .nav-folder-title — the lazy folder ` +
    'load never landed.\n' +
    (await dumpFolderState(page, folderPath)),
  );
}

/** How many `fileMap` keys sit under `folderPath/`. */
async function countChildrenInFileMap(page: Page, folderPath: string): Promise<number> {
  return page
    .evaluate((prefix) => {
      const app = (window as unknown as {
        app?: { vault?: { fileMap?: Record<string, unknown> } };
      }).app;
      const keys = Object.keys(app?.vault?.fileMap ?? {});
      return keys.filter((k) => k.startsWith(`${prefix}/`)).length;
    }, folderPath)
    .catch(() => 0);
}

/**
 * What IS in `fileMap` around `folderPath`, for the timeout message. A
 * bare "0 children" is ambiguous between "the folder isn't in the model
 * at all" (populate bug) and "it's there but the expand didn't load it"
 * (lazy-load bug); listing the folder itself, everything under its
 * prefix, and the `data-path`s the explorer is actually rendering
 * separates the two in one CI round.
 */
async function dumpFolderState(page: Page, folderPath: string): Promise<string> {
  const state = await page
    .evaluate((prefix) => {
      const app = (window as unknown as {
        app?: { vault?: { fileMap?: Record<string, unknown> } };
      }).app;
      const keys = Object.keys(app?.vault?.fileMap ?? {});
      return {
        fileMapKeys: keys.length,
        folderItself: keys.includes(prefix),
        under: keys.filter((k) => k.startsWith(`${prefix}/`)).slice(0, 20),
        sample: keys.slice(0, 20),
        navFolderTitles: Array.from(document.querySelectorAll('.nav-folder-title'))
          .map((el) => el.getAttribute('data-path'))
          .slice(0, 20),
      };
    }, folderPath)
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  return `vault.fileMap around "${folderPath}": ${JSON.stringify(state)}`;
}

/**
 * Diagnostic snapshot for the "File Explorer empty after a successful
 * SFTP connect+populate" failure. The bare Playwright "element(s) not
 * found" can't distinguish three very different root causes:
 *
 *   1. `VaultModelBuilder.build` inserted nothing (walk produced
 *      entries but every insert errored) — `fileMapKeys` ≈ 0.
 *   2. Model built but the File Explorer view never picked the
 *      `create` events up — `fileMapKeys` large, `navTitles` 0.
 *   3. Model built AND rendered, but the file-explorer leaf is in a
 *      collapsed/hidden sidebar — `navTitles` > 0, `display:none`.
 *
 * Captures the in-page vault model + every file-explorer leaf's
 * computed visibility, plus the tail of the shadow window's
 * structured log (where `VaultModelBuilder: built Nf + Md` / its
 * per-entry errors land), so one CI round is conclusive instead of
 * speculative. Read-only.
 */
export interface ShadowModelSnapshot {
  /** Entries in `vault.fileMap` (folders + files + the shadow .obsidian). */
  fileMapKeys: number;
  rootChildren: number;
  loadedFiles: number;
  /** `vault.getMarkdownFiles().length` — the remote `.md` the populate built. */
  markdownFiles: number;
  fileExplorerLeaves: number;
  leaves: Array<{
    navTitles: number;
    display: string;
    visibility: string;
    w: number;
    h: number;
  }>;
}

/**
 * Read the shadow window's in-page vault model + file-explorer leaf
 * geometry. This is the GROUND TRUTH for "did the remote vault load":
 * `vault.getMarkdownFiles()` / `fileMap` are what the product builds
 * from the remote walk, independent of whether headless Obsidian has
 * painted the File Explorer tree yet (the DOM `.nav-file-title`
 * visibility is a virtualised/lazy render that races in Xvfb). Read-only.
 */
async function readShadowModel(
  page: Page,
): Promise<ShadowModelSnapshot | { error: string }> {
  try {
    return await page.evaluate(() => {
      const app = (window as unknown as { app?: Record<string, unknown> }).app;
      const v = (app as { vault?: Record<string, unknown> } | undefined)?.vault as
        | {
            fileMap?: Record<string, unknown>;
            getRoot?: () => { children?: unknown[] };
            getAllLoadedFiles?: () => unknown[];
            getMarkdownFiles?: () => unknown[];
          }
        | undefined;
      const ws = (app as { workspace?: { getLeavesOfType?: (t: string) => unknown[] } } | undefined)
        ?.workspace;
      const leaves = ws?.getLeavesOfType?.('file-explorer') ?? [];
      const leafInfo = leaves.map((l) => {
        const el = (l as { containerEl?: HTMLElement }).containerEl;
        const navTitles = el?.querySelectorAll?.('.nav-file-title').length ?? -1;
        const cs = el ? getComputedStyle(el) : null;
        const rect = el?.getBoundingClientRect?.();
        return {
          navTitles,
          display: cs?.display ?? '?',
          visibility: cs?.visibility ?? '?',
          w: rect ? Math.round(rect.width) : -1,
          h: rect ? Math.round(rect.height) : -1,
        };
      });
      return {
        fileMapKeys: Object.keys(v?.fileMap ?? {}).length,
        rootChildren: v?.getRoot?.()?.children?.length ?? -1,
        loadedFiles: v?.getAllLoadedFiles?.().length ?? -1,
        markdownFiles: v?.getMarkdownFiles?.().length ?? -1,
        fileExplorerLeaves: leaves.length,
        leaves: leafInfo,
      };
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Diagnostic snapshot string: the in-page model + the shadow window's
 * structured-log tail (where `VaultModelBuilder: built Nf + Md` / its
 * per-entry errors land). Attached to assertion failures so a red
 * run is conclusive.
 */
export async function dumpShadowState(
  page: Page,
  shadowLogPath: string,
): Promise<string> {
  const m = await readShadowModel(page);
  const model = 'error' in m ? `evaluate-failed: ${m.error}` : JSON.stringify(m);

  let logTail = '(shadow console.log absent)';
  try {
    const raw = fs.readFileSync(shadowLogPath, 'utf8').replace(/\0/g, '');
    logTail = raw
      .trim()
      .split('\n')
      .slice(-30)
      .join('\n');
  } catch {
    /* absent / mid-write — keep the placeholder */
  }

  return (
    `shadow vault model: ${model}\n` +
    `--- ${shadowLogPath} (last 30 lines) ---\n${logTail}`
  );
}

/**
 * Wait until the shadow window has actually LOADED the remote vault —
 * the user-facing outcome the field report ("vault won't load") is
 * about. Asserts on the product's own model (`getMarkdownFiles() >= 1`
 * AND a file-explorer leaf exists), NOT on DOM `.nav-file-title`
 * visibility: the docker fixture vault always has `remote_demo*.md`,
 * so the populate building ≥1 markdown file into `vault.fileMap` is
 * the exact "the remote tree loaded" signal, and it is immune to
 * headless Obsidian's lazy/virtualised File Explorer paint (which
 * races under Xvfb and produced false reds even though the model and
 * the leaf were correct — diagnosed across runs 26015295742 /
 * 26016246390). Throws with the full diagnostic on timeout.
 */
export async function waitForShadowVaultLoaded(
  page: Page,
  shadowLogPath: string,
  timeoutMs = 30_000,
): Promise<ShadowModelSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: ShadowModelSnapshot | { error: string } | null = null;
  while (Date.now() < deadline) {
    last = await readShadowModel(page);
    if (
      !('error' in last) &&
      last.markdownFiles >= 1 &&
      last.fileExplorerLeaves >= 1
    ) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    'shadow vault did not load the remote tree ' +
    `(need getMarkdownFiles()>=1 AND a file-explorer leaf) within ${timeoutMs}ms.\n` +
    (await dumpShadowState(page, shadowLogPath)),
  );
}
