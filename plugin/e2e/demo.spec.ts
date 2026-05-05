import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { launchObsidian, type ObsidianHandle } from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Demo capture — uses CDP `Page.startScreencast` to record the
 * plugin walkthrough at the page's natural render rate, then
 * writes a per-frame `concat.txt` manifest the workflow turns into
 * a smooth GIF for the README.
 *
 * Static `page.screenshot` at waypoints isn't enough — the result
 * is jumpy. Screencast streams every paint, which gives ~10–20 fps
 * during transitions and idle quiet during holds. Per-frame
 * durations come from the timestamps the CDP event arrives at.
 *
 * Run: OBSIDIAN_PATH="..." npx playwright test --config e2e/playwright.config.ts demo.spec.ts
 * Output: e2e/demo-screenshots/{phase1,phase2}-NNNNN.png + concat.txt
 */

const SCREENSHOTS = path.resolve(__dirname, 'demo-screenshots');

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;

interface ScreencastFrame {
  /** PNG bytes. */
  buf: Buffer;
  /** Capture timestamp in ms since epoch — used to derive
   *  per-frame duration when generating the ffmpeg concat manifest. */
  ts: number;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
}

/**
 * Begin a CDP screencast on the given page. Frames push into the
 * provided array with timestamps for later concat-manifest building.
 */
async function startScreencast(page: Page, frames: ScreencastFrame[]): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  // The CDP protocol types aren't in Playwright's public types; the
  // event/method strings are documented at chromedevtools.github.io.
  session.on('Page.screencastFrame' as never, (async (frame: ScreencastFrameEvent) => {
    frames.push({ buf: Buffer.from(frame.data, 'base64'), ts: Date.now() });
    await session.send('Page.screencastFrameAck' as never, { sessionId: frame.sessionId } as never)
      .catch(() => { /* session may have been detached mid-flight */ });
  }) as never);
  await session.send('Page.startScreencast' as never, {
    format: 'png',
    quality: 90,
    maxWidth: 1024,
    maxHeight: 800,
    everyNthFrame: 1,
  } as never);
  return session;
}

async function stopScreencast(session: CDPSession): Promise<void> {
  await session.send('Page.stopScreencast' as never).catch(() => {});
  await session.detach().catch(() => {});
}

interface ManifestEntry {
  name: string;
  /** Seconds this frame holds before the next one fires. */
  duration: number;
}

/**
 * Persist captured frames as PNGs and return the matching concat
 * manifest entries (per-frame duration derived from timestamps,
 * clamped to a sane range so a long idle gap doesn't produce a
 * 10-second still).
 */
function saveFrames(
  frames: ScreencastFrame[],
  prefix: string,
): ManifestEntry[] {
  const manifest: ManifestEntry[] = [];
  for (let i = 0; i < frames.length; i++) {
    const name = `${prefix}-${String(i).padStart(5, '0')}.png`;
    fs.writeFileSync(path.join(SCREENSHOTS, name), frames[i].buf);
    const next = frames[i + 1];
    const rawDuration = next ? (next.ts - frames[i].ts) / 1000 : 0.2;
    // Clamp: too short = ffmpeg drops the frame; too long = boring
    // pause kills the demo's pacing.
    const duration = Math.max(0.04, Math.min(0.6, rawDuration));
    manifest.push({ name, duration });
  }
  return manifest;
}

function clearScreenshotsDir(): void {
  if (fs.existsSync(SCREENSHOTS)) {
    for (const f of fs.readdirSync(SCREENSHOTS)) {
      fs.unlinkSync(path.join(SCREENSHOTS, f));
    }
  } else {
    fs.mkdirSync(SCREENSHOTS, { recursive: true });
  }
}

test.beforeAll(async () => {
  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

test('capture demo screencast', async () => {
  clearScreenshotsDir();
  const allManifest: ManifestEntry[] = [];

  // ── Phase 1: original vault → connect notice ─────────────
  const { page } = obsidian;

  // Esc closes the Settings panel auto-opened by the trust-dismiss
  // path so the screencast starts on a clean local vault.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  const frames1: ScreencastFrame[] = [];
  const session1 = await startScreencast(page, frames1);

  // Hold initial vault state — file explorer shows local_demo*.md.
  await page.waitForTimeout(1_200);

  // Open Settings.
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(1_000);

  // Settings → Community plugins (shows Remote SSH listed).
  const cpTab = page.locator('.vertical-tab-nav-item:has-text("Community plugins")').first();
  if (await cpTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await cpTab.click();
    await page.waitForTimeout(1_000);
  }

  // Settings → Remote SSH (shows pre-configured E2E Test profile).
  const pluginTab = page.locator('.vertical-tab-nav-item:has-text("Remote SSH")').first();
  if (await pluginTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await pluginTab.click();
    await page.waitForTimeout(1_500);
  }

  // Close Settings.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // Open command palette.
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(400);

  // Type "Remote SSH" letter by letter; the palette filters live.
  await page.keyboard.type('Remote SSH', { delay: 70 });
  await page.waitForTimeout(900);

  // Press Enter on the highlighted "Connect to remote vault"
  // command -> the per-profile passphrase modal opens.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_200);

  // Click Connect on the passphrase modal -> SSH handshake fires
  // and a notice surfaces.
  const connectBtn = page.locator('.modal button:has-text("Connect")').first();
  await connectBtn.click();
  await page.waitForTimeout(2_500);

  await stopScreencast(session1);
  allManifest.push(...saveFrames(frames1, 'phase1'));
  console.log(`[demo] phase 1: ${frames1.length} frames`);

  // ── Phase 2: relaunch on shadow vault and screencast it ──
  // The shadow vault opens as a separate Electron process which
  // doesn't inherit our --remote-debugging-port. Workaround: read
  // ~/.config/obsidian/obsidian.json to find the new vault entry,
  // kill the original, and relaunch our managed instance pointed
  // at the shadow vault. Plugin auto-connect on first open
  // populates the file explorer with remote_demo*.md.
  const obsidianConfigPath = path.join(
    process.env.APPDATA ?? path.join(process.env.HOME ?? '', '.config'),
    'obsidian',
    'obsidian.json',
  );
  let shadowVaultPath: string | null = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(obsidianConfigPath, 'utf8')) as {
      vaults?: Record<string, { path?: string }>;
    };
    for (const id of Object.keys(cfg.vaults ?? {})) {
      const entryPath = cfg.vaults?.[id]?.path;
      if (entryPath && entryPath !== scaffold.vaultPath) {
        shadowVaultPath = entryPath;
        break;
      }
    }
  } catch (e) {
    console.log('[demo] failed to read obsidian.json:', String(e));
  }

  if (shadowVaultPath) {
    await obsidian.cleanup();
    obsidian = await launchObsidian(shadowVaultPath);

    // Close the trust-dismiss path's auto-opened Settings.
    await obsidian.page.keyboard.press('Escape');
    await obsidian.page.waitForTimeout(800);

    const frames2: ScreencastFrame[] = [];
    const session2 = await startScreencast(obsidian.page, frames2);

    // Hold the shadow-vault state long enough for auto-connect to
    // finish painting (status bar flips to "Connected", file
    // explorer fills with remote_demo*.md).
    await obsidian.page.waitForTimeout(2_500);

    // Ctrl+N creates `Untitled.md` in the (now-remote) vault.
    // Empirically Obsidian doesn't always auto-open the new file
    // in an editor pane when the vault is RPC-mediated — the file
    // appears in the file explorer but the workspace stays on the
    // empty-state ("No file is open") panel, which means
    // subsequent `keyboard.type` lands nowhere and the autosaved
    // file is empty. Belt-and-braces: if the editor isn't visible
    // after Ctrl+N, click the new file in the file explorer to
    // open it, then click into the editor body to ensure focus is
    // in CodeMirror.
    await obsidian.page.keyboard.press('Control+N');
    await obsidian.page.waitForTimeout(1_000);

    const editor = obsidian.page.locator('.cm-editor .cm-content').first();
    if (!await editor.isVisible({ timeout: 1_500 }).catch(() => false)) {
      const untitled = obsidian.page
        .locator('.nav-file-title[data-path^="Untitled"]')
        .first();
      if (await untitled.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await untitled.click();
        await obsidian.page.waitForTimeout(800);
      }
    }
    await editor.waitFor({ state: 'visible', timeout: 8_000 });
    await editor.click();

    await obsidian.page.keyboard.type(
      '# Demonstration\n\n',
      { delay: 60 },
    );
    await obsidian.page.keyboard.type(
      'This note was just created from Obsidian over SSH/RPC. ' +
      'Anything typed here is written to the remote host in real time.',
      { delay: 25 },
    );
    // Allow Obsidian's autosave + the daemon's write round-trip.
    // CI's autosave debounce is occasionally slower than local;
    // 4 s gives headroom without dragging out the GIF.
    await obsidian.page.waitForTimeout(4_000);

    await stopScreencast(session2);
    allManifest.push(...saveFrames(frames2, 'phase2'));
    console.log(`[demo] phase 2: ${frames2.length} frames`);
  }

  // Write the ffmpeg concat manifest. Quirk: the LAST file entry
  // must be repeated (without a following `duration`) — concat
  // ignores the final entry's duration otherwise.
  const lines: string[] = [];
  for (const m of allManifest) {
    lines.push(`file '${path.join(SCREENSHOTS, m.name)}'`);
    lines.push(`duration ${m.duration.toFixed(3)}`);
  }
  if (allManifest.length > 0) {
    lines.push(`file '${path.join(SCREENSHOTS, allManifest[allManifest.length - 1].name)}'`);
  }
  fs.writeFileSync(path.join(SCREENSHOTS, 'concat.txt'), lines.join('\n') + '\n');
  console.log(`[demo] wrote concat manifest: ${allManifest.length} frames total`);

  // ── Phase 3 (NON-VISUAL): SFTP verify the new note landed ────
  // This is the actual E2E assertion the GIF doesn't show. We
  // connect directly to the docker test sshd as the `tester` user
  // and read the just-created note off /home/tester/vault. The
  // file Obsidian made will have an "Untitled" name; we find the
  // one that isn't pre-seeded `remote_demo*.md` and assert its
  // content includes what we typed. If the typing flow only
  // updated the editor's local buffer (i.e. the daemon dropped
  // the write), this assert fails loud — the GIF wouldn't.
  const remote = new RemoteVerifier();
  const ok = await remote.connect();
  expect(ok, 'RemoteVerifier could not connect to test sshd').toBe(true);
  try {
    const entries = await remote.listDir('.');
    const isPreseeded = (n: string) =>
      /^remote_demo[1-5]\.md$/.test(n) || n === '.obsidian';
    const newNotes = entries.filter((n) => n.endsWith('.md') && !isPreseeded(n));
    expect(
      newNotes.length,
      `expected exactly one new .md on remote; got: [${entries.join(', ')}]`,
    ).toBeGreaterThanOrEqual(1);

    const content = await remote.readFile(newNotes[0]);
    expect(content, `${newNotes[0]} unreadable on remote`).not.toBeNull();
    expect(content!).toContain('# Demonstration');
    expect(content!).toContain('SSH/RPC');
    console.log(`[demo] verified remote file ${newNotes[0]} (${content!.length} chars)`);
  } finally {
    await remote.disconnect();
  }
});
