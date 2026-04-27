#!/usr/bin/env node
/**
 * Tear down the test sshd container started by start-test-sshd.mjs.
 * `docker compose down -v` also drops the bind-mount volume aliases
 * so a subsequent `up` rebuilds cleanly.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const r = spawnSync('docker', ['compose', 'down', '-v'],
  { cwd: repoRoot, stdio: 'inherit' });
process.exit(r.status ?? 0);
