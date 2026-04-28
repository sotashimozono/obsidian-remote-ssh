#!/usr/bin/env node
// CLI for the M10 perf gate's baseline maintenance.
//
// On `push` to `main` (or a nightly cron), copy the latest head NDJSON
// from `plugin/perf-results/` onto the orphan `perf-baseline` branch
// as `baseline.ndjson`, write a sidecar `baseline.sha` pointing at
// the head commit, and push. PR runs of run-compare.mjs check this
// branch out into `perf-baseline/` and diff against it.
//
// Bootstraps the orphan branch on first run (no `perf-baseline` ref
// on the remote yet → create one from a clean tree).
//
// Env contract (set by the workflow):
//   - PERF_COMMIT_SHA     head commit SHA recorded into the sidecar
//   - PERF_RESULTS_DIR    override `plugin/perf-results/` (rare)
//   - PERF_BASELINE_REF   override `perf-baseline` (rare)

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(pluginRoot, '..');

const RESULTS_DIR  = process.env.PERF_RESULTS_DIR ?? path.join(pluginRoot, 'perf-results');
const BASELINE_REF = process.env.PERF_BASELINE_REF ?? 'perf-baseline';
const COMMIT_SHA   = process.env.PERF_COMMIT_SHA ?? gitOutput(['rev-parse', 'HEAD']).trim();

function main() {
  const headFile = pickLatestNDJSON(RESULTS_DIR);
  if (!headFile) {
    console.log('[perf-baseline] no NDJSON in perf-results/ — bench was skipped or failed; not updating baseline.');
    return 0;
  }
  console.log(`[perf-baseline] head: ${path.basename(headFile)} → ${BASELINE_REF}/baseline.ndjson`);

  const headText = fs.readFileSync(headFile, 'utf8');
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-baseline-'));

  try {
    const remoteUrl = gitOutput(['config', '--get', 'remote.origin.url']).trim();
    if (!remoteUrl) throw new Error('perf-baseline: cannot read origin url');

    // Bootstrap the worktree. fetch the branch if it exists; otherwise
    // initialise an orphan branch with a clean tree.
    runIn(repoRoot, ['git', 'fetch', '--depth=1', 'origin', BASELINE_REF], { allowFail: true });
    const branchExists = gitOutput(['ls-remote', '--heads', 'origin', BASELINE_REF]).trim().length > 0;

    if (branchExists) {
      runIn(repoRoot, ['git', 'worktree', 'add', '--no-checkout', tmpRepo, `origin/${BASELINE_REF}`]);
      runIn(tmpRepo, ['git', 'checkout', '-B', BASELINE_REF, `origin/${BASELINE_REF}`]);
    } else {
      console.log(`[perf-baseline] bootstrapping orphan branch '${BASELINE_REF}' (first run)`);
      runIn(repoRoot, ['git', 'worktree', 'add', '--detach', tmpRepo, 'HEAD']);
      runIn(tmpRepo, ['git', 'checkout', '--orphan', BASELINE_REF]);
      runIn(tmpRepo, ['git', 'rm', '-rf', '--quiet', '.'], { allowFail: true });
    }

    fs.writeFileSync(path.join(tmpRepo, 'baseline.ndjson'), headText, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'baseline.sha'),   COMMIT_SHA + '\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpRepo, 'README.md'),
      [
        '# Phase C perf baseline',
        '',
        'This orphan branch holds the rolling baseline NDJSON used by',
        'the `perf-compare` step in `.github/workflows/integration.yml`.',
        'PR runs diff their fresh bench output against `baseline.ndjson`',
        'and post a Markdown comment on the PR.',
        '',
        '`baseline.ndjson` is rewritten by every push to `main` (or by a',
        'nightly cron) — do not commit changes here directly.',
        '',
        `Last updated from \`${COMMIT_SHA}\`.`,
        '',
      ].join('\n'),
      'utf8',
    );

    runIn(tmpRepo, ['git', 'add', 'baseline.ndjson', 'baseline.sha', 'README.md']);

    // No-op when the new bytes match what's already on the branch.
    const status = gitOutputIn(tmpRepo, ['status', '--porcelain']).trim();
    if (status.length === 0) {
      console.log('[perf-baseline] no change in baseline contents — skipping commit');
      return 0;
    }

    runIn(tmpRepo, ['git', '-c', 'user.email=actions@github.com', '-c', 'user.name=github-actions[bot]',
      'commit', '-m', `perf: update baseline from ${COMMIT_SHA.slice(0, 7)}`]);
    runIn(tmpRepo, ['git', 'push', 'origin', `HEAD:${BASELINE_REF}`]);
    console.log(`[perf-baseline] pushed updated baseline to origin/${BASELINE_REF}`);
    return 0;
  } finally {
    try { runIn(repoRoot, ['git', 'worktree', 'remove', '--force', tmpRepo], { allowFail: true }); }
    catch { /* best effort */ }
  }
}

function pickLatestNDJSON(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  if (entries.length === 0) return null;
  const sorted = entries
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return path.join(dir, sorted[0].f);
}

function runIn(cwd, argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, stdio: 'inherit' });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${argv.join(' ')} (in ${cwd}) exited ${r.status}`);
  }
  return r.status ?? 0;
}

function gitOutput(args) {
  return gitOutputIn(repoRoot, args);
}

function gitOutputIn(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) return '';
  return r.stdout;
}

process.exit(main());
