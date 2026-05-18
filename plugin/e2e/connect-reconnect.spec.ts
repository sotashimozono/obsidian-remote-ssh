import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  launchObsidian,
  driveConnectFlow,
  findShadowVaultPath,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import {
  logPathFor,
  waitForLog,
  waitForCount,
  countLog,
  assertAtMost,
} from './helpers/log-oracle';
import { assertSshdReachable, waitForSshdReachable } from './helpers/sshd';

/**
 * Reconnect e2e (Phase 2) — guards "再接続したときに vault が適切に
 * 読み込めない" from the field report.
 *
 * Flow: connect over SFTP with a valid path → kill the docker sshd
 * (unexpected drop) → assert the plugin actually enters the reconnect
 * loop (it must be VISIBLE, not a silent dead session) → bring sshd
 * back → assert it recovers, with no spawn storm.
 *
 * Recovered-oracle for SFTP: `setState` doesn't log and recovery has
 * no other stable logged line, but a successful reconnect re-runs
 * `SftpClient.connect`, which emits a *fresh* `SFTP channel open`.
 * So "the `SFTP channel open` count grew past the pre-drop baseline"
 * is the reliable, transport-correct recovery signal.
 *
 * This is the flakiest spec by nature (real docker kill + backoff +
 * real Obsidian). Budgets are generous and sshd is restored as soon
 * as the first failed attempt is observed, to stay inside the
 * ReconnectManager retry budget (1s×1.5→30s, ~5 retries).
 *
 * HARD-FAILS if sshd is unreachable at start — a connect-path spec
 * that silently skips is how the incident shipped green.
 */

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test.setTimeout(360_000);

function sshd(action: 'start' | 'stop'): void {
  execSync(`npm run sshd:${action}`, { cwd: PLUGIN_ROOT, stdio: 'pipe' });
}

test.describe('connect reconnect (SFTP, sshd drop → recover)', () => {
  let scaffold: ScaffoldResult;
  let scaffoldHandle: ObsidianHandle | null = null;
  let shadowHandle: ObsidianHandle | null = null;
  let sshdRestored = true;

  test.beforeAll(async () => {
    await assertSshdReachable();
    scaffold = scaffoldTestVault({ transport: 'sftp' });
  });

  test.afterAll(async () => {
    // Never leave the shared docker sshd down for later specs/runs.
    if (!sshdRestored) {
      try { sshd('start'); } catch { /* best effort */ }
    }
    try { await shadowHandle?.cleanup(); } catch { /* best effort */ }
    try { await scaffoldHandle?.cleanup(); } catch { /* best effort */ }
    scaffold?.cleanup();
  });

  test('an unexpected sshd drop enters a visible reconnect loop and recovers', async () => {
    scaffoldHandle = await launchObsidian(scaffold.vaultPath);
    await driveConnectFlow(scaffoldHandle.page);
    const shadowVaultPath = await findShadowVaultPath(scaffold.vaultPath, 20_000);
    await scaffoldHandle.cleanup();
    scaffoldHandle = null;

    shadowHandle = await launchObsidian(shadowVaultPath);
    const shadowLog = logPathFor(shadowVaultPath);

    // 1. Establish a healthy connection first.
    await waitForLog(shadowLog, /SFTP channel open/, 60_000, 'initial SFTP open');
    await waitForLog(
      shadowLog,
      /Adapter patched via SFTP/,
      60_000,
      'initial connect must patch',
    );

    // 2. Drop the remote unexpectedly.
    sshd('stop');
    sshdRestored = false;

    // 3. The drop MUST surface as a reconnect loop, not a silent dead
    //    session (the field complaint was a connection that just
    //    stopped working with no feedback).
    await waitForLog(
      shadowLog,
      /reconnect attempt \d+\/\d+ failed/,
      90_000,
      'an unexpected drop must enter a VISIBLE reconnect loop',
    );

    // Capture the baseline open-count HERE, not right after the
    // initial patch. Reading it earlier races the rolling log buffer:
    // the initial connect can emit more than one `SFTP channel open`
    // and a late-flushed one would inflate the baseline OR, worse,
    // satisfy the `+1` recovery check below from a *pre-drop* open
    // (false pass). At this point sshd is down and the reconnect-fail
    // line is logged well after every pre-drop open — so the count is
    // stable and no new open can appear until we restore.
    const baselineOpens = countLog(shadowLog, /SFTP channel open/);

    // 4. Restore the remote immediately — stay within the retry
    //    budget so a later attempt can succeed.
    sshd('start');
    sshdRestored = true;
    // `npm run sshd:start` returns the moment `docker compose up -d`
    // exits — sshd inside the container is NOT accepting connections
    // yet. Wait for the port to actually come back so a slow/failed
    // restart fails as a HARNESS fault here, not as a misleading
    // "reconnect must recover" plugin failure 150s later.
    await waitForSshdReachable(60_000);

    // 5. Recovery: a successful reconnect re-opens the SFTP channel,
    //    so the open-count must grow past the pre-drop baseline.
    await waitForCount(
      shadowLog,
      /SFTP channel open/,
      baselineOpens + 1,
      150_000,
      'reconnect must recover (a fresh SFTP channel open after restore)',
    );

    // 6. No spawn storm through the whole drop/recover cycle.
    assertAtMost(
      shadowLog,
      /WindowSpawner: firing obsidian:\/\/open/,
      2,
      'reconnect must not loop-spawn the shadow vault',
    );

    // 7. The vault is usable again — File Explorer still renders.
    //    `expect(...).toBeVisible` auto-waits AND surfaces the real
    //    Playwright failure (page closed, target crashed, selector
    //    never matched). The old `.isVisible().catch(() => false)`
    //    swallowed all of those into a bare `false`, turning a crashed
    //    page into a context-free "expected true, got false".
    await expect(
      shadowHandle.page
        .locator('.nav-files-container .nav-file-title')
        .first(),
      'File Explorer should still render after reconnect',
    ).toBeVisible({ timeout: 30_000 });
  });
});
