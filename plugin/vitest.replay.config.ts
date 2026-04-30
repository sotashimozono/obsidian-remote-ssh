import { defineConfig } from 'vitest/config';

// Vitest config used by `npm run test:replay` (and the
// `replay.yml` CI workflow). Discovers test files under
// `tests-replay/` — the scratch dir the replay script populates
// with the previous release tag's tests. Excludes the integration
// tier the same way `vitest.config.ts` does.
//
// Why a separate config: the default config's `include` pin is
// `tests/**/*.test.ts`, which doesn't match the sibling
// `tests-replay/` directory. Mounting the previous tag's tests
// inside `tests/` would let vitest discover them under the default
// config too, but then `npm run test` would run them as well — we
// want the replay invocation alone to see them.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests-replay/**/*.test.ts'],
    exclude: ['tests-replay/integration/**', 'node_modules/**'],
  },
});
