import { test, expect, type Page } from '@playwright/test';
import {
  launchObsidian,
  connectAndOpenShadow,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';

/**
 * M11 (#125) — remote-write reflection scenarios.
 *
 * Direction: REMOTE → Obsidian. The companion `sync.spec.ts` covers
 * the opposite (Obsidian writes → remote sees them); this file covers
 * the path that `sync.spec.ts` doesn't: the daemon's `fs.watch`
 * notification plus the `ChangeListener` → `Vault adapter` →
 * File Explorer re-render chain.
 *
 * Each scenario writes (or mutates / deletes / renames) a file on the
 * remote via a direct SFTP connection (`RemoteVerifier`, NOT the
 * plugin), then asserts that the connected Obsidian window's File
 * Explorer reflects the change within `REFLECT_TIMEOUT_MS`.
 *
 * Skipped en bloc when:
 *   - the Docker test sshd is unreachable (no key file or no port 2222)
 *   - the plugin failed to connect to the remote vault
 *
 * Run: `npm run test:e2e:reflect`
 */

const STAMP = Date.now().toString(36);

// fs.watch notification → RPC push → ChangeListener → adapter update
// → File Explorer re-render. Empirically this is sub-second on a warm
// connection but the first event after connect can take 5+ s as the
// daemon's watcher finishes its initial scan. 15 s gives headroom
// without burying real regressions.
const REFLECT_TIMEOUT_MS = 15_000;

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
let connected = false;

test.beforeAll(async () => {
  remote = new RemoteVerifier();
  const remoteOk = await remote.connect();
  if (!remoteOk) {
    test.skip(true, 'Docker test sshd is not running — skipping reflect tests');
    return;
  }

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // connectAndOpenShadow drives the connect command, clicks through
  // the passphrase modal, and returns a fresh handle attached to
  // the shadow vault Obsidian opens for the connected profile. Any
  // assertion below now runs against the SHADOW vault's window —
  // which is the only window where remote files actually appear.
  // The previous heuristic (`items > 0`) was a false positive:
  // local_demo*.md from the scaffold seed was always non-zero, so
  // `connected` was true even when the connect command was a no-op.
  try {
    obsidian = await connectAndOpenShadow(obsidian, scaffold.vaultPath);
    connected = true;
  } catch (e) {
    test.skip(true, `connectAndOpenShadow failed: ${String(e)}`);
  }
});

test.afterAll(async () => {
  if (remote) {
    await Promise.allSettled([
      remote.removeFile(`${STAMP}-create.md`),
      remote.removeFile(`${STAMP}-modify.md`),
      remote.removeFile(`${STAMP}-delete.md`),
      // rename source path: only present on remote if test 4 crashed
      // before `remote.rename()` ran. removeFile ignores ENOENT so
      // it's safe when the rename succeeded normally.
      remote.removeFile(`${STAMP}-rename-src.md`),
      remote.removeFile(`${STAMP}-renamed.md`),
      remote.removeFile(`${STAMP}-image.md`),
      remote.removeFile(`${STAMP}-image.png`),
    ]);
    await remote.disconnect();
  }
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

test.describe('Remote → Obsidian reflection (M11)', () => {
  test.beforeEach(() => {
    if (!connected) test.skip(true, 'Not connected to remote');
  });

  test('1 — create: remote-written file appears in File Explorer', async () => {
    const file = `${STAMP}-create.md`;
    await remote.writeFile(file, `# Created remotely at ${STAMP}\n`);

    await expect(
      fileLocator(obsidian.page, file),
    ).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });
  });

  test('2 — modify: remote overwrite reflects in editor + advances mtime', async () => {
    const file = `${STAMP}-modify.md`;
    const sentinel = `MODIFIED-${STAMP}`;
    await remote.writeFile(file, '# initial\n');
    const before = await remote.stat(file);
    expect(before).not.toBeNull();

    // Wait for File Explorer to pick up the create first; the modify
    // assert below would otherwise race against the initial reflect.
    await expect(
      fileLocator(obsidian.page, file),
    ).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });

    // Open the note before mutating so we can watch the editor pane
    // pick up the change. Obsidian activates a file on single click;
    // .cm-content is CodeMirror's content host.
    await fileLocator(obsidian.page, file).click();
    await expect(
      obsidian.page.locator('.cm-editor .cm-content'),
    ).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });

    // Sleep past 1 s so the second write's mtime is at least 1 second
    // ahead of the first (sftp's mtime resolution is per-second).
    await obsidian.page.waitForTimeout(1_100);
    await remote.writeFile(file, `# ${sentinel}\n`);

    // (a) Daemon-side ground truth: the SFTP write landed.
    const after = await waitForMtimeChange(remote, file, before!.mtimeMs);
    expect(after.mtimeMs).toBeGreaterThan(before!.mtimeMs);

    // (b) Reflect chain end-to-end: the open editor shows the new
    // content. This is the assert M2 was missing — without it the
    // test only proves SFTP works, not that fs.watch → RPC push →
    // Vault adapter → editor refresh delivered the change.
    await expect(
      obsidian.page.locator('.cm-editor .cm-content'),
    ).toContainText(sentinel, { timeout: REFLECT_TIMEOUT_MS });
  });

  test('3 — delete: remote-removed file disappears from File Explorer', async () => {
    const file = `${STAMP}-delete.md`;
    await remote.writeFile(file, '# delete-me\n');
    await expect(
      fileLocator(obsidian.page, file),
    ).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });

    await remote.removeFile(file);

    await expect(
      fileLocator(obsidian.page, file),
    ).toBeHidden({ timeout: REFLECT_TIMEOUT_MS });
  });

  test('4 — rename: old path gone + new path present', async () => {
    const fromFile = `${STAMP}-rename-src.md`;
    const toFile = `${STAMP}-renamed.md`;
    await remote.writeFile(fromFile, '# rename-me\n');
    await expect(
      fileLocator(obsidian.page, fromFile),
    ).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });

    await remote.rename(fromFile, toFile);

    await expect(
      fileLocator(obsidian.page, fromFile),
    ).toBeHidden({ timeout: REFLECT_TIMEOUT_MS });
    await expect(
      fileLocator(obsidian.page, toFile),
    ).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });
  });

  test('5 — large-file image render: 1 MB PNG renders via ResourceBridge', async () => {
    const png = `${STAMP}-image.png`;
    const noteName = `${STAMP}-image.md`;

    // 1 MB minimal-but-valid PNG. Real PNG header + IHDR + IDAT chunk
    // padded with zeros — Obsidian/Chromium will decode it as a 1×1
    // transparent image. The point is to push >1 MB through
    // ResourceBridge, not to render a meaningful picture.
    await remote.writeBinaryFile(png, makeOnePngOf(1024 * 1024));
    await remote.writeFile(noteName, `![[${png}]]\n`);

    await expect(
      fileLocator(obsidian.page, noteName),
    ).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });

    // Open the markdown note. Obsidian's File Explorer activates a
    // file on a single click; preview mode is the default.
    await fileLocator(obsidian.page, noteName).click();

    // The embedded image surfaces as an <img> inside the markdown
    // preview pane. Asserting `naturalWidth > 0` is what catches a
    // ResourceBridge regression — a broken bridge would still render
    // the <img> tag but with naturalWidth === 0.
    const img = obsidian.page.locator('.markdown-preview-view img').first();
    await expect(img).toBeVisible({ timeout: REFLECT_TIMEOUT_MS });
    const decoded = await img.evaluate((el: HTMLImageElement) =>
      el.naturalWidth > 0 && el.naturalHeight > 0
    );
    expect(decoded).toBe(true);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Locate a File Explorer entry by filename. Obsidian sets
 * `data-path` on every `.nav-file-title` so the selector is stable
 * across themes / language packs.
 */
function fileLocator(page: Page, fileName: string) {
  return page.locator(`.nav-file-title[data-path$="${fileName}"]`);
}

async function waitForMtimeChange(
  r: RemoteVerifier,
  file: string,
  baselineMs: number,
): Promise<{ mtimeMs: number; size: number }> {
  const deadline = Date.now() + REFLECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await r.stat(file);
    if (s && s.mtimeMs > baselineMs) return s;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`mtime did not advance for ${file} within ${REFLECT_TIMEOUT_MS}ms`);
}

/**
 * Build a ~`size`-byte buffer that decodes as a valid PNG. Layout:
 *   [8-byte PNG signature]
 *   [IHDR chunk: 1×1 RGBA, 25 bytes including length+type+data+crc]
 *   [IDAT chunk: zlib-deflated single-pixel data]
 *   [IEND chunk]
 * The buffer is padded with zeros AFTER IEND; chromium tolerates
 * trailing garbage and decodes the declared 1×1 image regardless.
 *
 * Why a real PNG and not random bytes: the large-file scenario
 * specifically targets the ResourceBridge thumbnail / image path,
 * which gates on Content-Type sniffing. Random bytes get served as
 * application/octet-stream and the <img>'s naturalWidth stays 0.
 */
function makeOnePngOf(size: number): Buffer {
  // Tiny pre-built 1×1 transparent PNG (67 bytes).
  const seed = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
    + '890000000d49444154789c6300010000000500010d0a2db40000000049454e44'
    + 'ae426082',
    'hex',
  );
  if (size <= seed.length) return seed.subarray(0, size);
  const pad = Buffer.alloc(size - seed.length);
  return Buffer.concat([seed, pad]);
}
