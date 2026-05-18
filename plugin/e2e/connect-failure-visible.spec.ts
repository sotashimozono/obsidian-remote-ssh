import { test, expect } from '@playwright/test';
import {
  launchObsidian,
  connectAndWaitForShadowVault,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import {
  logPathFor,
  waitForLog,
  assertAtMost,
  countLog,
} from './helpers/log-oracle';
import { assertSshdReachable } from './helpers/sshd';

/**
 * Negative-path connect e2e — guards the ACTUAL field incident.
 *
 * Root-cause of the "1.0.49 broke connect" report was NOT a code
 * regression: a profile pointed at a remotePath that doesn't exist on
 * the remote, so connect legitimately failed — but
 * `runAutoConnect`'s failure was only `logger.warn`'d (invisible to a
 * user looking at the still-focused source window) and
 * `openShadowVaultFor` had no re-entrancy guard, so impatient
 * re-clicks produced a WindowSpawner churn that *looked* like a hang.
 *
 * This spec scaffolds exactly that situation (sftp + non-existent
 * remotePath) and asserts the fixed contract:
 *
 *   - connect FAILS (it must — the path is bogus) and that failure is
 *     RECORDED visibly in the log (not a silent hang);
 *   - it does NOT proceed to patch/populate (no false "connected");
 *   - it does NOT spawn-storm.
 *
 * HARD-FAILS if sshd is unreachable — same rationale as the happy
 * path: a connect-path spec that silently skips is how the incident
 * shipped green.
 */

test.setTimeout(240_000);

test.describe('connect failure is visible (bad remotePath, SFTP)', () => {
  let scaffold: ScaffoldResult;
  let scaffoldHandle: ObsidianHandle | null = null;
  let shadowHandle: ObsidianHandle | null = null;

  test.beforeAll(async () => {
    await assertSshdReachable();
    // sshd is up and reachable, but this path does NOT exist in the
    // docker fixture — connect must fail at the remote-path check.
    scaffold = scaffoldTestVault({
      transport: 'sftp',
      remotePath: '/home/tester/this-path-does-not-exist',
    });
  });

  test.afterAll(async () => {
    try { await shadowHandle?.cleanup(); } catch { /* best effort */ }
    try { await scaffoldHandle?.cleanup(); } catch { /* best effort */ }
    scaffold?.cleanup();
  });

  test('a bad remotePath fails visibly — no silent hang, no spawn storm, no false connect', async () => {
    // Per-attempt cutoff — `beforeAll`'s scaffold (and its shadow dir)
    // is reused across Playwright retries with APPEND-mode logs. The
    // `.toBe(0)` patch/populate assertions below are negative checks:
    // a stale `Adapter patched` / `populateVaultFromRemote` line from
    // a prior attempt would make them spuriously non-zero. Scope every
    // oracle to lines emitted at/after this instant.
    const since = new Date().toISOString();

    scaffoldHandle = await launchObsidian(scaffold.vaultPath);

    const shadowVaultPath = await connectAndWaitForShadowVault(
      scaffoldHandle.page, scaffold.vaultPath, 45_000,
    );

    // C2 guard: one Connect drive must not have produced a spawn storm
    // in the source window.
    assertAtMost(
      logPathFor(scaffold.vaultPath),
      /WindowSpawner: firing obsidian:\/\/open/,
      3,
      'source window must not loop-spawn on a single Connect',
      since,
    );

    await scaffoldHandle.cleanup();
    scaffoldHandle = null;
    shadowHandle = await launchObsidian(shadowVaultPath);
    const shadowLog = logPathFor(shadowVaultPath);

    // The failure MUST be recorded — connect either fails outright or
    // runAutoConnect's guard fires. Either way it is visible in the
    // log within budget, not an unbounded silent wait.
    await waitForLog(
      shadowLog,
      /Connect failed|did not reach CONNECTED state|auto-connect to .* failed/,
      90_000,
      'a bad remotePath must fail VISIBLY (logged), not hang silently',
      since,
    );

    // It must NOT have lied about success: no patch, no populate.
    expect(
      countLog(shadowLog, /Adapter patched via/, since),
      'a failed connect must not patch the adapter',
    ).toBe(0);
    expect(
      countLog(shadowLog, /populateVaultFromRemote\([^)]*\):.*entries/, since),
      'a failed connect must not populate the vault',
    ).toBe(0);

    // And the shadow window itself must not spawn-storm.
    assertAtMost(
      shadowLog,
      /WindowSpawner: firing obsidian:\/\/open/,
      2,
      'shadow window must not loop-spawn on a failed connect',
      since,
    );
  });
});
