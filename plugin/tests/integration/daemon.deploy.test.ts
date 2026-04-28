import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { deployTestDaemon, LOCAL_DAEMON_BINARY, type DeployedDaemon } from './helpers/deployDaemonOnce';
import { TEST_PRIVATE_KEY } from './helpers/makeAdapter';
import { establishRpcConnection } from '../../src/transport/RpcConnection';

/**
 * Phase A2 — runtime daemon deploy smoke.
 *
 * Verifies the helper PR A3 will rely on actually works against the
 * docker test sshd:
 *
 *   1. The local-built daemon binary is staged where the helper looks
 *      (via `npm run build:server` — CI sets this up before running
 *      the integration job).
 *   2. `ServerDeployer` (production code path, no test-only mocks)
 *      uploads + starts the daemon, the token file lands on disk, and
 *      the unix socket is listening.
 *   3. A fresh unix-socket Duplex through the same SSH session can run
 *      the `auth` + `server.info` handshake → daemon returns its
 *      version + protocolVersion + capabilities.
 *   4. `teardown()` actually stops the process.
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}
if (!fs.existsSync(LOCAL_DAEMON_BINARY)) {
  throw new Error(
    `Daemon binary missing at ${LOCAL_DAEMON_BINARY}. ` +
    'Run `npm run build:server` before `npm run test:integration`.',
  );
}

describe('integration: daemon deploy via ServerDeployer', () => {
  let daemon: DeployedDaemon;

  beforeAll(async () => {
    daemon = await deployTestDaemon({ label: 'deploy-smoke' });
  });

  afterAll(async () => {
    await daemon.teardown();
  });

  it('returns a populated token + the canonical .obsidian-remote/* paths', () => {
    expect(daemon.result.token.length).toBeGreaterThan(8);
    expect(daemon.result.remoteSocketPath.endsWith('.obsidian-remote/server.sock')).toBe(true);
    expect(daemon.result.remoteTokenPath.endsWith('.obsidian-remote/token')).toBe(true);
    expect(daemon.result.remoteBinaryPath.endsWith('.obsidian-remote/server')).toBe(true);
  });

  it('leaves the daemon process running and the socket listening', async () => {
    // pgrep prints PIDs; a non-empty stdout means at least one match.
    const ps = await daemon.ssh.exec('pgrep -f obsidian-remote-server');
    expect(ps.exitCode).toBe(0);
    expect(ps.stdout.trim().length).toBeGreaterThan(0);

    const sock = await daemon.ssh.exec(`test -S "$HOME/${daemon.result.remoteSocketPath}"`);
    expect(sock.exitCode).toBe(0);
  });

  it('completes the auth + server.info handshake', async () => {
    const stream = await daemon.ssh.openUnixStream(daemon.result.remoteSocketPath);
    const conn   = await establishRpcConnection({ stream, token: daemon.result.token });
    try {
      expect(conn.info.version.length).toBeGreaterThan(0);
      expect(conn.info.protocolVersion).toBeGreaterThan(0);
      expect(Array.isArray(conn.info.capabilities)).toBe(true);
    } finally {
      conn.close();
    }
  });

  it('teardown stops the daemon process', async () => {
    // Run teardown explicitly to validate the contract; afterAll will
    // be a no-op (idempotent) afterwards.
    await daemon.teardown();

    // pgrep with no matches exits 1; we can't reuse `daemon.ssh` here
    // because teardown disconnected it, so stand up a one-shot session.
    const { SftpClient } = await import('../../src/ssh/SftpClient');
    const { AuthResolver } = await import('../../src/ssh/AuthResolver');
    const { SecretStore } = await import('../../src/ssh/SecretStore');
    const { HostKeyStore } = await import('../../src/ssh/HostKeyStore');
    const { buildTestProfile } = await import('./helpers/makeAdapter');

    const ssh = new SftpClient(new AuthResolver(new SecretStore()), new HostKeyStore());
    await ssh.connect(buildTestProfile('deploy-smoke-verify'));
    try {
      const ps = await ssh.exec('pgrep -f obsidian-remote-server');
      // pgrep exits 1 when nothing matches; stdout is empty.
      expect(ps.exitCode).not.toBe(0);
      expect(ps.stdout.trim()).toBe('');
    } finally {
      await ssh.disconnect();
    }
  });
});
