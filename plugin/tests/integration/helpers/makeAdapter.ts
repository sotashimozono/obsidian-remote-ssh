import * as path from 'node:path';
import { SftpClient } from '../../../src/ssh/SftpClient';
import { AuthResolver } from '../../../src/ssh/AuthResolver';
import { SecretStore } from '../../../src/ssh/SecretStore';
import { HostKeyStore } from '../../../src/ssh/HostKeyStore';
import { ReadCache } from '../../../src/cache/ReadCache';
import { DirCache } from '../../../src/cache/DirCache';
import { SftpRemoteFsClient } from '../../../src/adapter/SftpRemoteFsClient';
import { SftpDataAdapter } from '../../../src/adapter/SftpDataAdapter';
import { PathMapper } from '../../../src/path/PathMapper';
import type { SshProfile } from '../../../src/types';

/**
 * Connection coordinates for the docker test sshd. Mirrors the
 * constants in `ssh.integration.test.ts` so multi-client tests can
 * reuse the same container without duplicating fixture knowledge.
 */
export const TEST_HOST = '127.0.0.1';
export const TEST_PORT = 2222;
export const TEST_USER = 'tester';
export const TEST_VAULT = `/home/${TEST_USER}/vault`;

export const TEST_PRIVATE_KEY = path.resolve(
  __dirname, '..', '..', '..', '..', 'docker', 'keys', 'id_test',
);

/**
 * Build an SSH profile pointed at the docker test sshd. Each call
 * gets a unique `id` so callers wiring multiple clients don't
 * accidentally share profile-keyed state (host key TOFU bookkeeping,
 * secret refs).
 */
export function buildTestProfile(label: string): SshProfile {
  return {
    id:                  `integration-${label}`,
    name:                `Docker test sshd (${label})`,
    host:                TEST_HOST,
    port:                TEST_PORT,
    username:            TEST_USER,
    authMethod:          'privateKey',
    privateKeyPath:      TEST_PRIVATE_KEY,
    remotePath:          TEST_VAULT,
    connectTimeoutMs:    10_000,
    keepaliveIntervalMs: 0,
    keepaliveCountMax:   0,
  };
}

/**
 * One client-side stack: a connected SftpClient, its caches, the
 * PathMapper carrying its clientId, and the SftpDataAdapter wired on
 * top. Bundled together so the test can hold both clients side by
 * side and tear them down cleanly.
 *
 * `vaultRoot` is the per-test-file subdir created in `setupClientPair`;
 * the adapter's `remoteBasePath` is set to this so vault-relative
 * paths the test writes line up under the subdir, not the whole
 * shared `/home/tester/vault/`.
 */
export interface TestClient {
  clientId: string;
  ssh: SftpClient;
  pathMapper: PathMapper;
  adapter: SftpDataAdapter;
  vaultRoot: string;
  disconnect(): Promise<void>;
}

/**
 * Build a single client stack. Caller is responsible for `disconnect`
 * (the bundled helper makes that a one-liner per client).
 */
export async function makeTestClient(opts: {
  clientId: string;
  /** Absolute remote path the adapter should treat as the vault root. */
  vaultRoot: string;
  /** Label folded into the SshProfile id; just for logging clarity. */
  label?: string;
}): Promise<TestClient> {
  const auth = new AuthResolver(new SecretStore());
  const hostKeys = new HostKeyStore();
  const ssh = new SftpClient(auth, hostKeys);
  await ssh.connect(buildTestProfile(opts.label ?? opts.clientId));

  const fsClient = new SftpRemoteFsClient(ssh);
  const pathMapper = new PathMapper(opts.clientId);

  const adapter = new SftpDataAdapter(
    fsClient,
    opts.vaultRoot,
    new ReadCache(),
    new DirCache(),
    'integration-vault',
    pathMapper,
    null,  // no ResourceBridge in integration tests
    null,  // no write-conflict prompt
  );

  return {
    clientId: opts.clientId,
    ssh,
    pathMapper,
    adapter,
    vaultRoot: opts.vaultRoot,
    async disconnect() {
      try { await ssh.disconnect(); } catch { /* best effort */ }
    },
  };
}

/**
 * Create a unique per-test-file subdir under the shared docker vault,
 * spin up two clients pointed at it with different clientIds, and
 * return them along with a cleanup hook the test's `afterAll` must
 * call. Subdir name folds in a timestamp + random suffix so parallel
 * test files don't trample each other.
 *
 * Both clients connect through a shared `SftpClient` for setup
 * (mkdirp on the subdir + cleanup) plus their own dedicated session
 * for the test itself.
 */
export async function setupClientPair(opts: {
  testLabel: string;
  clientIdA?: string;
  clientIdB?: string;
}): Promise<{
  a: TestClient;
  b: TestClient;
  vaultRoot: string;
  cleanup: () => Promise<void>;
}> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subdir = `${TEST_VAULT}/multiclient-${opts.testLabel}-${stamp}`;

  // Bootstrap session: just to mkdirp the subdir and (later) tear it
  // down. Kept separate from the per-client sessions so teardown
  // works even if a client's adapter is mid-call.
  const bootAuth = new AuthResolver(new SecretStore());
  const bootSsh  = new SftpClient(bootAuth, new HostKeyStore());
  await bootSsh.connect(buildTestProfile(`${opts.testLabel}-boot`));
  await bootSsh.mkdirp(subdir);

  const a = await makeTestClient({
    clientId:  opts.clientIdA ?? 'alpha',
    vaultRoot: subdir,
    label:     `${opts.testLabel}-a`,
  });
  const b = await makeTestClient({
    clientId:  opts.clientIdB ?? 'beta',
    vaultRoot: subdir,
    label:     `${opts.testLabel}-b`,
  });

  return {
    a, b,
    vaultRoot: subdir,
    async cleanup() {
      await a.disconnect();
      await b.disconnect();
      // Recursive delete via the bootstrap session — the per-test
      // subdir is fully owned by this run, so a coarse rm is fine.
      try { await rmRecursive(bootSsh, subdir); } catch { /* best effort */ }
      try { await bootSsh.disconnect();         } catch { /* best effort */ }
    },
  };
}

/**
 * Walk-and-delete a remote subtree using the SftpClient's primitives.
 * SftpClient doesn't expose a recursive delete, so we DIY it. Order:
 * descend into folders, delete files inside, rmdir on the way out.
 */
async function rmRecursive(ssh: SftpClient, dir: string): Promise<void> {
  let entries;
  try {
    entries = await ssh.list(dir);
  } catch {
    // Already gone, or never existed — nothing to do.
    return;
  }
  for (const e of entries) {
    const child = `${dir}/${e.name}`;
    if (e.isDirectory) {
      await rmRecursive(ssh, child);
    } else {
      try { await ssh.remove(child); } catch { /* keep going */ }
    }
  }
  try { await ssh.rmdir(dir); } catch { /* keep going */ }
}
