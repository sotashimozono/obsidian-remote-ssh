#!/usr/bin/env node
/*
 * build-server — cross-compile the obsidian-remote-server Go daemon
 * for linux/amd64 and stage the resulting binary into
 * <plugin>/server-bin/ so dev-install.mjs picks it up alongside
 * main.js / manifest.json / styles.css.
 *
 * Usage:
 *   node scripts/build-server.mjs
 *   node scripts/build-server.mjs --goos=linux --goarch=arm64
 *
 * Locating Go:
 *   1. `go` on PATH (preferred).
 *   2. `~/tools/go-portable/go/bin/go(.exe)` — useful for the dev box
 *      where Go isn't installed system-wide; ignored elsewhere.
 *   3. Otherwise the script exits with a clear error.
 *
 * Skipping:
 *   Set REMOTE_SSH_SKIP_SERVER_BUILD=1 to no-op (build:install can
 *   then run on machines that don't have Go and don't need a fresh
 *   binary).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const repoRoot   = path.resolve(pluginRoot, '..');
const serverDir  = path.join(repoRoot, 'server');
const stageDir   = path.join(pluginRoot, 'server-bin');

if (process.env.REMOTE_SSH_SKIP_SERVER_BUILD === '1') {
  console.log('build-server: REMOTE_SSH_SKIP_SERVER_BUILD set, skipping');
  process.exit(0);
}

// Parse flags.
const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const goos   = flag('goos')   ?? 'linux';
const goarch = flag('goarch') ?? 'amd64';
const outName = `obsidian-remote-server-${goos}-${goarch}` + (goos === 'windows' ? '.exe' : '');

const goExe = locateGo();
if (!goExe) {
  console.error('build-server: could not locate the Go toolchain.');
  console.error('  Install Go (https://go.dev/dl/) or set REMOTE_SSH_SKIP_SERVER_BUILD=1.');
  process.exit(1);
}

if (!fs.existsSync(serverDir)) {
  console.error(`build-server: ${serverDir} does not exist`);
  process.exit(1);
}

fs.mkdirSync(stageDir, { recursive: true });
const outPath = path.join(stageDir, outName);

console.log(`build-server: ${goExe} build -o ${path.relative(repoRoot, outPath)}  (GOOS=${goos} GOARCH=${goarch})`);

const result = spawnSync(
  goExe,
  ['build', '-o', outPath, './cmd/obsidian-remote-server'],
  {
    cwd: serverDir,
    stdio: 'inherit',
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
  },
);

if (result.status !== 0) {
  console.error(`build-server: go build exited ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log(`build-server: staged ${path.relative(repoRoot, outPath)} (${prettySize(fs.statSync(outPath).size)})`);

function locateGo() {
  const fromPath = which('go') ?? which('go.exe');
  if (fromPath) return fromPath;

  // Fallback: the portable Go on the dev box.
  const portableCandidates = [
    path.join(os.homedir(), 'tools', 'go-portable', 'go', 'bin', 'go.exe'),
    path.join(os.homedir(), 'tools', 'go-portable', 'go', 'bin', 'go'),
  ];
  for (const c of portableCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function which(cmd) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT?.split(';') ?? ['.EXE', '.CMD', '.BAT'])
    : [''];
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function prettySize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
