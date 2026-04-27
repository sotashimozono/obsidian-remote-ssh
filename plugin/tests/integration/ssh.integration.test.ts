import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SftpClient } from '../../src/ssh/SftpClient';
import { AuthResolver } from '../../src/ssh/AuthResolver';
import { SecretStore } from '../../src/ssh/SecretStore';
import { HostKeyStore } from '../../src/ssh/HostKeyStore';
import type { SshProfile } from '../../src/types';

/**
 * Integration tests against a real openssh-server running in docker
 * (`docker-compose.yml` at the repo root, brought up by
 * `npm run sshd:start`). Exercises the actual ssh2 handshake +
 * SFTP channel rather than the unit-test mocks; meant to catch
 * regressions in the auth / channel code that mocks can't see.
 *
 * Skipped automatically when the test keypair isn't present, so
 * `npm run test:integration` from a fresh checkout fails loud at
 * the first describe but `npm test` (unit) keeps working.
 */
const REPO_ROOT      = path.resolve(__dirname, '..', '..', '..');
const PRIVATE_KEY    = path.join(REPO_ROOT, 'docker', 'keys', 'id_test');
const TEST_HOST      = '127.0.0.1';
const TEST_PORT      = 2222;
const TEST_USER      = 'tester';
// In-container path: `/home/tester/vault` — bind-mounted from
// `docker/test-vault/` on the host. Each test file gets a unique
// subdir so parallel runs (within the file) don't clobber each
// other; the file as a whole runs serially via vitest's
// fileParallelism: false.
const REMOTE_VAULT   = `/home/${TEST_USER}/vault`;

if (!fs.existsSync(PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}

function buildProfile(): SshProfile {
  return {
    id:                  'integration-test',
    name:                'Docker test sshd',
    host:                TEST_HOST,
    port:                TEST_PORT,
    username:            TEST_USER,
    authMethod:          'privateKey',
    privateKeyPath:      PRIVATE_KEY,
    remotePath:          REMOTE_VAULT,
    connectTimeoutMs:    10_000,
    keepaliveIntervalMs: 0,
    keepaliveCountMax:   0,
  };
}

describe('integration: SSH against docker sshd', () => {
  let client: SftpClient;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subdir = `${REMOTE_VAULT}/integration-${stamp}`;

  beforeAll(async () => {
    const auth   = new AuthResolver(new SecretStore());
    const hkstore = new HostKeyStore();
    client = new SftpClient(auth, hkstore);
    await client.connect(buildProfile());
    await client.mkdirp(subdir);
  });

  afterAll(async () => {
    try {
      // Best-effort cleanup: delete files we created. The directory
      // itself is bind-mounted from the host — leaving the empty
      // subdir behind is harmless and gitignored.
      const entries = await client.list(subdir);
      for (const e of entries) {
        if (e.isFile) await client.remove(`${subdir}/${e.name}`);
      }
    } catch { /* container may already be down */ }
    await client.disconnect();
  });

  it('lists the empty vault subdir', async () => {
    const entries = await client.list(subdir);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(0);
  });

  it('writes and reads a small text file', async () => {
    const remote = `${subdir}/hello.txt`;
    await client.writeBinary(remote, Buffer.from('integration test\n', 'utf8'));
    const data = await client.readBinary(remote);
    expect(data.toString('utf8')).toBe('integration test\n');
  });

  it('writes and reads a binary blob', async () => {
    const remote = `${subdir}/blob.bin`;
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    await client.writeBinary(remote, payload);
    const data = await client.readBinary(remote);
    expect(data.length).toBe(payload.length);
    expect(data.equals(payload)).toBe(true);
  });

  it('stat returns a file-type result with sane size and mtime', async () => {
    const remote = `${subdir}/stat-target.txt`;
    await client.writeBinary(remote, Buffer.from('xyz', 'utf8'));
    const s = await client.stat(remote);
    expect(s.isFile).toBe(true);
    expect(s.size).toBe(3);
    // mtime is unix milliseconds; just sanity-check it's recent.
    const ageMs = Date.now() - s.mtime;
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(5 * 60 * 1000);
  });

  it('exists distinguishes present vs missing files', async () => {
    expect(await client.exists(subdir)).toBe(true);
    expect(await client.exists(`${subdir}/never-existed`)).toBe(false);
  });

  it('list includes a file we just wrote', async () => {
    const remote = `${subdir}/visible.md`;
    await client.writeBinary(remote, Buffer.from('# hi'));
    const entries = await client.list(subdir);
    const names = entries.map(e => e.name);
    expect(names).toContain('visible.md');
  });

  it('remove deletes the target', async () => {
    const remote = `${subdir}/to-remove.txt`;
    await client.writeBinary(remote, Buffer.from('bye'));
    expect(await client.exists(remote)).toBe(true);
    await client.remove(remote);
    expect(await client.exists(remote)).toBe(false);
  });
});

// `os` import suppresses an unused warning if the file gets
// reorganised; keep until we actually need it.
void os;
