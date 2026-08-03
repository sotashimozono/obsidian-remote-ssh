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
 *   E2E_DEMO       — set to include `demo.spec.ts` (media capture only)
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // `demo.spec.ts` is the SCREENCAST RECORDER, not a test: it asserts
  // nothing, it drives the UI purely to emit PNG frames for the README GIF.
  // `testMatch` was picking it up, so it ran inside the behavioural
  // "Obsidian E2E smoke" job — where it burns CI minutes and can only ever
  // go red for reasons unrelated to product behaviour, which is corrosive to
  // trusting the suite. Excluded by default; the `Record demo + push GIF`
  // workflow sets E2E_DEMO=1 to opt it back in.
  testIgnore: process.env.E2E_DEMO ? [] : ['**/demo.spec.ts'],
  timeout: 120_000,
  retries: 1,
  // Obsidian is a single-instance app, so a machine can only ever drive ONE
  // window: `workers: 1` is not tunable. But that constraint is PER MACHINE —
  // it does not stop us splitting the suite across several CI runners. See
  // `projects` below.
  workers: 1,
  // ─── shards ──────────────────────────────────────────────────────────────
  //
  // The suite grew to 60+ tests and ~30 minutes on one runner, serially. The
  // groups below let CI fan them out across runners (`--project=<name>`), one
  // Obsidian per machine, so wall time collapses to the slowest group.
  //
  // ALL THREE RUN ON EVERY PR. The split is for speed, not for dropping
  // coverage — a suite you only run sometimes is a suite you don't trust.
  //
  // A second, load-bearing benefit: each runner brings up its OWN docker sshd,
  // so the groups cannot contaminate each other's remote vault. We hit exactly
  // that: a fixture plugin left in the remote `community-plugins.json` by one
  // spec reddened `sync.spec` in another. Isolation by construction beats
  // remembering to clean up.
  //
  // Grouped by COST, so the three finish at roughly the same time — not by
  // theme. Rebalance when a group's wall time drifts.
  projects: [
    {
      // Fast: connect lifecycle + the core round-trips. Seconds each.
      name: 'core',
      testMatch: [
        '**/smoke.spec.ts',
        '**/connect-*.spec.ts',
        '**/sync.spec.ts',
        '**/reflect.spec.ts',
        '**/restart-settings.spec.ts',
        '**/plugin-code-roundtrip.spec.ts',
        '**/fs-sync-bridge-probe.spec.ts',
      ],
    },
    {
      // The knowledge layer: links, metadata, graph, images. Heavy polls and
      // multi-MB image fixtures.
      name: 'features',
      testMatch: [
        '**/links-metadata.spec.ts',
        '**/vault-features.spec.ts',
        '**/images.spec.ts',
        // Measures what that knowledge layer COSTS: Obsidian fills
        // `metadataCache` by reading every note through our adapter, so the
        // whole vault's bytes cross the wire for indexing alone. Grouped here
        // because it is a question about this layer — and because `core`
        // already carries the other probe.
        '**/metadata-index-probe.spec.ts',
      ],
    },
    {
      // Heaviest: cache-pressure pushes >72 MiB over SSH to provably exceed the
      // 64 MiB ReadCache budget, and fs-visibility relaunches Obsidian a lot.
      name: 'stress',
      testMatch: [
        '**/cache-pressure.spec.ts',
        '**/fs-visibility.spec.ts',
      ],
    },
    // The screencast RECORDER — asserts nothing, emits PNG frames for the
    // README GIF. Once `projects` exists, a spec in NO project never runs at
    // all, so `testIgnore` alone would silently kill the demo capture. It gets
    // its own project, and that project only exists when the recorder workflow
    // asks for it.
    ...(process.env.E2E_DEMO
      ? [{ name: 'demo', testMatch: ['**/demo.spec.ts'] }]
      : []),
  ],
  use: {
    // Playwright's DEFAULT actionTimeout is 0 — wait FOREVER. With Obsidian's
    // virtualised File Explorer under Xvfb a node can be *attached but never
    // actionable* (hover popovers swallow pointer events, rows paint lazily), so
    // a bare `.click()` blocks until the whole test times out: minutes burned
    // with NO message, which reads as "the product hung" when in fact the
    // harness was waiting. Bound it — an unactionable element fails with
    // Playwright's own locator diagnostic, well inside the 120 s test budget.
    //
    // This lived at the config's TOP LEVEL, where `actionTimeout` is not an
    // option at all, so the bound it describes had never once applied — `tsc`
    // says so directly ("'actionTimeout' does not exist in type 'Config<…>'").
    // Every unbounded click in the suite could still eat a whole budget, and
    // several did on run 30775609866.
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../e2e-results' }],
  ],
});
