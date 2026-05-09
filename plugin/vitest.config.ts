import { defineConfig } from 'vitest/config';
import * as path from 'path';

// Default config runs unit tests only. Integration tests live under
// `tests/integration/` and need a running docker sshd container —
// they're routed through `vitest.integration.config.ts` and
// invoked via `npm run test:integration`.
export default defineConfig({
  resolve: {
    alias: {
      // Obsidian's npm package is types-only. UI/settings tests need
      // a runtime, so route `import 'obsidian'` to our hand-rolled mock.
      // Production builds use the real Obsidian provided by the host
      // process — this alias only applies inside vitest.
      obsidian: path.resolve(__dirname, 'tests/__mocks__/obsidian.ts'),
    },
  },
  test: {
    // jsdom gives us HTMLElement / document so the obsidian-mock can
    // patch DOM helpers and Modal.contentEl works for free. The
    // existing non-DOM tests stay happy under jsdom too — Buffer +
    // fs work the same as in node mode (jsdom runs on top of node).
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**', 'tests/__mocks__/**'],
    // Vitest 4's default `forks` pool spawns child Node processes that
    // do NOT inherit the parent's `NODE_OPTIONS=--max-old-space-size`,
    // so each worker is capped at the V8 default (~4 GiB). Once the
    // suite grew to ~70 jsdom test files, individual workers started
    // hitting `FATAL ERROR: Reached heap limit` mid-file (notably
    // SftpClient.unit.test.ts, which exercises ~50 mock-heavy tests).
    // Pass `--max-old-space-size=6144` to the spawned workers via
    // `execArgv` so each gets the same 6 GiB headroom we set for the
    // CI workflow's parent process. (In Vitest 4 `execArgv` is a
    // top-level key inside `test`, not under `poolOptions`.)
    execArgv: ['--max-old-space-size=6144'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // src/ui/** + src/settings/** are testable on the
      // tests/__mocks__/obsidian.ts runtime mock. Files below are
      // excluded only until they have a dedicated test suite — drop
      // entries from this list as the suites land, then bump the
      // global thresholds back up.
      exclude: [
        'src/main.ts',
        'src/ui/ConnectModal.ts',
        'src/ui/HostKeyMismatchModal.ts',
        'src/ui/KbdInteractiveModal.ts',
        'src/ui/LargeTransferBar.ts',
        'src/ui/PendingEditsBar.ts',
        'src/ui/PendingEditsModal.ts',
        'src/ui/PendingPluginsModal.ts',
        'src/ui/RemotePathBrowserModal.ts',
        // #149 — heavy xterm.js DOM rendering + ResizeObserver makes
        // jsdom unit tests impractical. Manual smoke against a real
        // Obsidian window covers this; RemoteShell has its own unit tests.
        'src/ui/RemoteTerminalView.ts',
        'src/ui/StatusBar.ts',
        'src/ui/ThreeWayMergeModal.ts',
        'src/ui/WriteConflictModal.ts',
        'src/settings/ProfileForm.ts',
      ],
      // Calibrated for the current measured scope. Bring back up as
      // more UI/settings suites land and per-file coverage rises.
      thresholds: {
        lines: 76,
        branches: 70,
        functions: 72,
      },
    },
  },
});
