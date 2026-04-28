import * as fs from 'node:fs';
import * as path from 'node:path';
import { SftpClient } from '../../../src/ssh/SftpClient';
import { AuthResolver } from '../../../src/ssh/AuthResolver';
import { SecretStore } from '../../../src/ssh/SecretStore';
import { HostKeyStore } from '../../../src/ssh/HostKeyStore';
import { ServerDeployer, type DeployResult } from '../../../src/transport/ServerDeployer';
import { buildTestProfile, TEST_VAULT } from './makeAdapter';

/**
 * Where `npm run build:server` stages the linux/amd64 daemon binary.
 * Mirrors the production `locateDaemonBinary()` location, but rooted
 * at the plugin source tree (not `<vault>/.obsidian/plugins/...`)
 * because integration tests run from the repo, not from a real vault.
 */
export const LOCAL_DAEMON_BINARY = path.resolve(
  __dirname, '..', '..', '..', 'server-bin', 'obsidian-remote-server-linux-amd64',
);

export interface DeployedDaemon {
  /** Auth-handshake material for opening RPC streams. */
  result: DeployResult;
  /**
   * The SftpClient session that owns the deployment — kept so callers
   * can `openUnixStream(result.remoteSocketPath)` and run RPC against
   * the same channel without standing up a second SSH connection.
   */
  ssh: SftpClient;
  /**
   * Stop the daemon process on the remote and disconnect the
   * dedicated SSH session. Idempotent.
   */
  teardown(): Promise<void>;
}

/**
 * Build + connect a fresh SftpClient, then deploy the Go daemon to
 * the docker test sshd via the same `ServerDeployer` production uses.
 *
 * Each test file is expected to call this once in `beforeAll` and
 * `teardown()` in `afterAll`. Calling it twice in one process is
 * fine — `killExisting: true` (the deployer default) cleans up the
 * previous process before starting the new one — but each call costs
 * a few seconds of upload + chmod + spawn, so the per-file pattern
 * is the cheapest stable answer.
 *
 * Throws if the daemon binary isn't staged at `LOCAL_DAEMON_BINARY`.
 * In CI, `integration.yml` runs `npm run build:server` first to put
 * it there; locally, `npm run build:server` does the same.
 */
export async function deployTestDaemon(opts?: {
  /** Override the remote vault root the daemon serves. Default `/home/tester/vault`. */
  vaultRoot?: string;
  /** Folded into the SshProfile id so logs say which test file owns this session. */
  label?: string;
}): Promise<DeployedDaemon> {
  if (!fs.existsSync(LOCAL_DAEMON_BINARY)) {
    throw new Error(
      `Daemon binary missing at ${LOCAL_DAEMON_BINARY}. ` +
      'Run `npm run build:server` (or set REMOTE_SSH_SKIP_SERVER_BUILD=0) before `npm run test:integration`.',
    );
  }

  const auth     = new AuthResolver(new SecretStore());
  const hostKeys = new HostKeyStore();
  const ssh      = new SftpClient(auth, hostKeys);
  await ssh.connect(buildTestProfile(opts?.label ?? 'daemon'));

  // Hold the deployer instance, NOT just the result — `ServerDeployer.stop`
  // needs the kill pattern + remote paths it stored on `deploy()`. A fresh
  // instance would have null `deployedState` and silently no-op.
  const deployer = new ServerDeployer(ssh);
  const result   = await deployer.deploy({
    localBinaryPath: LOCAL_DAEMON_BINARY,
    remoteVaultRoot: opts?.vaultRoot ?? TEST_VAULT,
    // remoteBinaryPath / remoteSocketPath / remoteTokenPath / remoteLogPath
    // all default to `.obsidian-remote/{server,server.sock,token,server.log}`
    // — same as production, so the path conventions stay exercised.
  });

  let stopped = false;
  return {
    result,
    ssh,
    async teardown() {
      if (!stopped) {
        try { await deployer.stop(); }
        catch { /* best effort — daemon may already be down */ }
        stopped = true;
      }
      try { await ssh.disconnect(); } catch { /* best effort */ }
    },
  };
}
