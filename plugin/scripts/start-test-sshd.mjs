#!/usr/bin/env node
/**
 * Bring up the test sshd container.
 *
 *   - Generates `docker/keys/id_test{,.pub}` if missing (ed25519,
 *     no passphrase). Both files are gitignored.
 *   - Runs `docker compose up -d --build` from the repo root.
 *   - Waits for sshd to accept connections on 127.0.0.1:2222 (using
 *     the compose healthcheck) before returning.
 *   - Prints the public key, container name, and host:port so a
 *     human knows what just happened.
 *
 * Idempotent: re-running it just re-checks the keys, brings the
 * container back up if it was stopped, and waits for healthy.
 *
 * Used by the integration test suite (`npm run test:integration`).
 */

import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const keyDir   = path.join(repoRoot, 'docker', 'keys');
const keyPath  = path.join(keyDir, 'id_test');
const pubPath  = `${keyPath}.pub`;

fs.mkdirSync(keyDir,                                            { recursive: true });
fs.mkdirSync(path.join(repoRoot, 'docker', 'test-vault'),       { recursive: true });

if (!fs.existsSync(keyPath)) {
  console.log(`Generating ed25519 keypair at ${keyPath}`);
  // -N '' = no passphrase, -q = no banner. -f overwrites (already
  // checked nonexistence above).
  spawnRequire('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q', '-C', 'obsidian-remote-ssh-test']);
} else {
  console.log(`Reusing existing keypair at ${keyPath}`);
}

console.log('Bringing up docker compose service `sshd`…');
spawnRequire('docker', ['compose', 'up', '-d', '--build', 'sshd'], { cwd: repoRoot });

console.log('Waiting for sshd to be healthy…');
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const out = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}',
    'obsidian-remote-ssh-test-sshd'], { encoding: 'utf8' });
  const status = (out.stdout || '').trim();
  if (status === 'healthy') {
    console.log('sshd is healthy.');
    console.log('');
    console.log(`  host:        127.0.0.1`);
    console.log(`  port:        2222`);
    console.log(`  user:        tester`);
    console.log(`  private key: ${keyPath}`);
    console.log(`  public key:  ${pubPath}`);
    console.log('');
    process.exit(0);
  }
  if (status === 'unhealthy' || status === 'exited') {
    console.error(`sshd entered unhealthy state: ${status}`);
    process.exit(1);
  }
  // 'starting' or empty (container not yet up) — wait a tick.
  await new Promise(r => setTimeout(r, 1000));
}
console.error('Timed out waiting for sshd to become healthy.');
process.exit(1);

// ─── helpers ───────────────────────────────────────────────────────────

function spawnRequire(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    if (r.error && r.error.code === 'ENOENT') {
      console.error(`Missing required tool: ${cmd}. Is it on PATH?`);
    }
    process.exit(r.status ?? 1);
  }
}
