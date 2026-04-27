import { defineConfig } from 'vitest/config';

// Default config runs unit tests only. Integration tests live under
// `tests/integration/` and need a running docker sshd container —
// they're routed through `vitest.integration.config.ts` and
// invoked via `npm run test:integration`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/ui/**', 'src/settings/**'],
    },
  },
});
