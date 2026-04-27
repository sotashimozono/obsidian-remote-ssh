import { defineConfig } from 'vitest/config';

// Integration tests against the docker sshd container started by
// `npm run sshd:start`. Slower than unit tests (real network +
// keypair handshake) so they live in their own config and aren't
// included by default.
//
// Run manually with `npm run test:integration`. The CI integration
// job (`.github/workflows/integration.yml`) brings docker up, runs
// this config, and tears down.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // Each test usually opens its own SSH session; serialise so we
    // don't fight over the single sshd container.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
