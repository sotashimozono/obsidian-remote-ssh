import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from 'ssh2';
import { CertificateAgent } from '../../src/ssh/CertificateAgent';
import { enableCertificateAuth } from '../../src/ssh/certificateAuth';
import { loadDiskCertificate } from '../../src/ssh/DiskCertificate';
import { TEST_HOST, TEST_PORT, TEST_USER, TEST_PRIVATE_KEY } from './helpers/makeAdapter';
import { SSHD_CONTAINER, TEST_PROXY_COMMAND } from '../../test-env/target';

/**
 * #536, end to end: an OpenSSH certificate held by an `ssh-agent`.
 *
 * This is the test the issue asks for, and the only thing standing between an
 * ssh2 bump and a user who cannot connect — `certificateAuth.ts` reaches into
 * ssh2 internals, and nothing short of a real handshake proves they still
 * work.
 *
 * The setup mirrors an organisation that issues short-lived certificates: a
 * CA the server trusts, a user key that is NOT in `authorized_keys`, and a
 * certificate for it in the agent. Plain public-key auth therefore cannot
 * succeed and only the certificate can get in — otherwise the test would pass
 * without proving anything.
 *
 * The container's sshd config is modified and restored; the agent and its
 * throwaway keys live in a temp dir that is removed afterwards.
 */

const CONTAINER = SSHD_CONTAINER;
const CA_REMOTE = '/etc/ssh/cert-test-ca.pub';
const CONF_REMOTE = '/etc/ssh/sshd_config.d/cert-test-ca.conf';

function have(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).error === undefined;
  } catch {
    return false;
  }
}

/** ssh-keygen prints its usage and exits non-zero; presence is what matters. */
const TOOLS_PRESENT = have('docker', ['version'])
  && have('ssh-keygen', ['-?'])
  && have('ssh-agent', ['-h']);
/** `npm run sshd:start` generates this and the container trusts its public half. */
const PLAIN_KEY_PRESENT = fs.existsSync(TEST_PRIVATE_KEY);

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();

let dir = '';
let agentSocket = '';
let agentPid = '';
/** A second agent holding only the ordinary key the server already trusts. */
let plainAgentSocket = '';
let plainAgentPid = '';
/** A third agent holding only an RSA key and its RSA certificate. */
let rsaAgentSocket = '';
let rsaAgentPid = '';
/** And a fourth for ECDSA — the last certificate type nothing exercised. */
let ecdsaAgentSocket = '';
let ecdsaAgentPid = '';
let configured = false;

/** Block the setup thread without a timer; vitest owns the event loop here. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForSshd(): void {
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', CONTAINER, 'sh', '-c', "ss -lnt | grep -q ':22 '"]).status === 0) {
      return;
    }
    pause(500);
  }
  throw new Error('sshd did not come back after the config change');
}

beforeAll(() => {
  if (!RUN_HERE) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orst-cert-'));

  // A CA, a user key the server does not know, and a certificate for it.
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-f', path.join(dir, 'ca'), '-N', '', '-C', 'cert-test-ca']);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-f', path.join(dir, 'id'), '-N', '', '-C', 'cert-test-user']);
  run('ssh-keygen', [
    '-q', '-s', path.join(dir, 'ca'), '-I', 'cert-test', '-n', TEST_USER, '-V', '+1h',
    path.join(dir, 'id.pub'),
  ]);

  // The same, with RSA. Ed25519 hides a whole class of bug here: its key
  // type and its signature type are the same string, so a client that
  // conflates the two still works. RSA separates them — the certificate is
  // `ssh-rsa-cert-v01@openssh.com` while the signature must be `ssh-rsa`,
  // `rsa-sha2-256` or `rsa-sha2-512`, and OpenSSH checks that the pair agrees.
  run('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-f', path.join(dir, 'ca-rsa'), '-N', '', '-C', 'cert-test-ca-rsa']);
  run('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-f', path.join(dir, 'id-rsa'), '-N', '', '-C', 'cert-test-user-rsa']);
  run('ssh-keygen', [
    '-q', '-s', path.join(dir, 'ca-rsa'), '-I', 'cert-test-rsa', '-n', TEST_USER, '-V', '+1h',
    path.join(dir, 'id-rsa.pub'),
  ]);

  // And ECDSA. RSA broke precisely because it was the type no test covered;
  // ECDSA was then the only one left in that position.
  run('ssh-keygen', ['-q', '-t', 'ecdsa', '-b', '256', '-f', path.join(dir, 'ca-ecdsa'), '-N', '', '-C', 'cert-test-ca-ecdsa']);
  run('ssh-keygen', ['-q', '-t', 'ecdsa', '-b', '256', '-f', path.join(dir, 'id-ecdsa'), '-N', '', '-C', 'cert-test-user-ecdsa']);
  run('ssh-keygen', [
    '-q', '-s', path.join(dir, 'ca-ecdsa'), '-I', 'cert-test-ecdsa', '-n', TEST_USER, '-V', '+1h',
    path.join(dir, 'id-ecdsa.pub'),
  ]);

  // Teach the container to trust the CA. Mark it dirty BEFORE touching it:
  // `sshd -t` runs after the file is already written, so a failure there
  // still leaves state that afterAll has to remove.
  configured = true;
  // Both CAs go in one file — TrustedUserCAKeys takes a list.
  fs.writeFileSync(
    path.join(dir, 'cas.pub'),
    fs.readFileSync(path.join(dir, 'ca.pub'), 'utf8') +
    fs.readFileSync(path.join(dir, 'ca-rsa.pub'), 'utf8') +
    fs.readFileSync(path.join(dir, 'ca-ecdsa.pub'), 'utf8'),
  );
  run('docker', ['cp', path.join(dir, 'cas.pub'), `${CONTAINER}:${CA_REMOTE}`]);
  run('docker', ['exec', CONTAINER, 'sh', '-c',
    `printf 'TrustedUserCAKeys ${CA_REMOTE}\\n' > ${CONF_REMOTE} && sshd -t`]);
  run('docker', ['restart', CONTAINER]);
  waitForSshd();

  // An agent holding that key and its certificate, and nothing else.
  const started = run('ssh-agent', ['-s']);
  agentSocket = /SSH_AUTH_SOCK=([^;]+);/.exec(started)?.[1] ?? '';
  agentPid = /SSH_AGENT_PID=([^;]+);/.exec(started)?.[1] ?? '';
  run('ssh-add', [path.join(dir, 'id')], { SSH_AUTH_SOCK: agentSocket });

  // An agent holding ONLY the RSA key and its certificate — separate, so an
  // Ed25519 success cannot stand in for an RSA one.
  const rsa = run('ssh-agent', ['-s']);
  rsaAgentSocket = /SSH_AUTH_SOCK=([^;]+);/.exec(rsa)?.[1] ?? '';
  rsaAgentPid = /SSH_AGENT_PID=([^;]+);/.exec(rsa)?.[1] ?? '';
  run('ssh-add', [path.join(dir, 'id-rsa')], { SSH_AUTH_SOCK: rsaAgentSocket });

  const ecdsa = run('ssh-agent', ['-s']);
  ecdsaAgentSocket = /SSH_AUTH_SOCK=([^;]+);/.exec(ecdsa)?.[1] ?? '';
  ecdsaAgentPid = /SSH_AGENT_PID=([^;]+);/.exec(ecdsa)?.[1] ?? '';
  run('ssh-add', [path.join(dir, 'id-ecdsa')], { SSH_AUTH_SOCK: ecdsaAgentSocket });

  // A separate agent holding ONLY the repo's ordinary test key, which is in
  // the container's authorized_keys. Separate so neither test can pass on
  // the other's credential.
  if (PLAIN_KEY_PRESENT) {
    const plain = run('ssh-agent', ['-s']);
    plainAgentSocket = /SSH_AUTH_SOCK=([^;]+);/.exec(plain)?.[1] ?? '';
    plainAgentPid = /SSH_AGENT_PID=([^;]+);/.exec(plain)?.[1] ?? '';
    run('ssh-add', [TEST_PRIVATE_KEY], { SSH_AUTH_SOCK: plainAgentSocket });
  }
}, 180_000);

afterAll(() => {
  for (const pid of [agentPid, plainAgentPid, rsaAgentPid, ecdsaAgentPid]) {
    if (pid) { try { process.kill(Number(pid)); } catch { /* already gone */ } }
  }
  if (configured) {
    // Always put the container back, even if a test failed.
    try {
      run('docker', ['exec', CONTAINER, 'rm', '-f', CONF_REMOTE, CA_REMOTE]);
      run('docker', ['restart', CONTAINER]);
      waitForSshd();
    } catch { /* best effort */ }
  }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}, 180_000);

/** Connect once and resolve with who the server says we are. */
function connect(withCertificateSupport: boolean, socket = agentSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = new Client();
    if (withCertificateSupport) enableCertificateAuth(client);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('timed out')); }, 20_000);

    client.on('ready', () => {
      client.exec('id -un', (err, stream) => {
        if (err) { clearTimeout(timer); client.end(); return reject(err); }
        let out = '';
        stream.on('data', (d: Buffer) => { out += d.toString('utf8'); })
          .on('close', () => { clearTimeout(timer); client.end(); resolve(out.trim()); });
      });
    });
    client.on('error', (e) => { clearTimeout(timer); reject(e); });

    client.connect({
      host: TEST_HOST,
      port: TEST_PORT,
      username: TEST_USER,
      agent: withCertificateSupport ? new CertificateAgent(socket) : socket,
      hostVerifier: () => true,
      readyTimeout: 15_000,
    });
  });
}

/**
 * Only where the server is directly reachable. This file drives a bare ssh2
 * `Client` rather than `SftpClient`, so it cannot follow a `ProxyCommand` —
 * and what it tests is which bytes the certificate handshake puts on the
 * wire, which the route to the server cannot change. Running it a second
 * time over a proxy would cost time and prove nothing.
 */
const RUN_HERE = TOOLS_PRESENT && !TEST_PROXY_COMMAND;

describe.skipIf(!RUN_HERE)('integration: an OpenSSH certificate held by an agent (#536)', () => {
  it('authenticates, and the server agrees who we are', async () => {
    await expect(connect(true)).resolves.toBe(TEST_USER);
  }, 60_000);

  it.skipIf(!PLAIN_KEY_PRESENT)('still authenticates an ORDINARY agent key, which is most people', async () => {
    // The certificate path must not cost everyone else their login. ssh2's
    // own agent strips the algorithm name off the agent's signature before
    // its authPK writes the packet; a review caught that this agent did not,
    // which corrupted every plain-key signature. Nothing short of a real
    // handshake with a real agent notices.
    await expect(connect(true, plainAgentSocket)).resolves.toBe(TEST_USER);
  }, 60_000);

  it('authenticates with an RSA certificate too', async () => {
    // The certificate is `ssh-rsa-cert-v01@openssh.com`; the signature has to
    // be one of ssh-rsa / rsa-sha2-256 / rsa-sha2-512, and OpenSSH's
    // `sshkey_check_sigtype()` rejects the login when the algorithm named on
    // the wire does not match the one that actually signed. Ed25519 cannot
    // catch that — there the two names are identical.
    await expect(connect(true, rsaAgentSocket)).resolves.toBe(TEST_USER);
  }, 60_000);

  it('authenticates with an ECDSA certificate too', async () => {
    // The third and last certificate type. Its signature is SSH-format r/s,
    // not the DER an ECDSA key produces locally, and its key type and
    // signature type share a name like Ed25519's — so neither of the other
    // two tests stands in for it.
    await expect(connect(true, ecdsaAgentSocket)).resolves.toBe(TEST_USER);
  }, 60_000);

  it('fails without it — the failure users report today', async () => {
    // Stock ssh2 drops the certificate identity and offers only the plain
    // key, which this server does not know. If this ever starts passing,
    // ssh2 gained certificate support and the override can be retired.
    await expect(connect(false)).rejects.toThrow(/All configured authentication methods failed/);
  }, 60_000);
});

/**
 * The other shape the same credential takes: no agent at all, just the private
 * key and its `<key>-cert.pub` sitting on disk (what `mwinit` and most CA
 * tooling drop next to `id_ecdsa`). `ssh` loads the sibling automatically;
 * `DiskCertificateAgent` reproduces that, signing locally instead of via a
 * socket. The keys the agent block already generated carry a matching
 * `*-cert.pub`, so we reuse them — no agent process involved.
 */
function connectDisk(keyBase: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const agent = loadDiskCertificate(keyBase, fs.readFileSync(keyBase));
    if (!agent) return reject(new Error(`no -cert.pub beside ${keyBase}`));

    const client = new Client();
    enableCertificateAuth(client);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('timed out')); }, 20_000);

    client.on('ready', () => {
      client.exec('id -un', (err, stream) => {
        if (err) { clearTimeout(timer); client.end(); return reject(err); }
        let out = '';
        stream.on('data', (d: Buffer) => { out += d.toString('utf8'); })
          .on('close', () => { clearTimeout(timer); client.end(); resolve(out.trim()); });
      });
    });
    client.on('error', (e) => { clearTimeout(timer); reject(e); });

    client.connect({
      host: TEST_HOST,
      port: TEST_PORT,
      username: TEST_USER,
      agent,
      hostVerifier: () => true,
      readyTimeout: 15_000,
    });
  });
}

describe.skipIf(!RUN_HERE)('integration: an on-disk OpenSSH certificate, no agent (#536)', () => {
  it('authenticates with an Ed25519 certificate read from disk', async () => {
    await expect(connectDisk(path.join(dir, 'id'))).resolves.toBe(TEST_USER);
  }, 60_000);

  it('authenticates with an RSA certificate read from disk', async () => {
    // Same RSA subtlety as the agent path: signed with SHA-512, advertised as
    // rsa-sha2-512, or `sshkey_check_sigtype` rejects it.
    await expect(connectDisk(path.join(dir, 'id-rsa'))).resolves.toBe(TEST_USER);
  }, 60_000);

  it('authenticates with an ECDSA certificate read from disk', async () => {
    // The signature the local key produces is DER; it must reach the wire as
    // SSH string(r) string(s). This is the exact case that first prompted the
    // fix on Windows, where no agent was running.
    await expect(connectDisk(path.join(dir, 'id-ecdsa'))).resolves.toBe(TEST_USER);
  }, 60_000);
});
