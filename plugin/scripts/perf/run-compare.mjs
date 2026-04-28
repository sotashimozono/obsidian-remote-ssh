#!/usr/bin/env node
// CLI wrapper around `compare.mjs` for the M10 perf gate.
//
// Reads the latest head NDJSON from `plugin/perf-results/`, fetches
// the baseline from the orphan `perf-baseline` branch, computes the
// diff, posts a Markdown comment to the PR via `gh pr comment`, and
// exits non-zero when any p95 regressed past its per-span tolerance
// AND the gate is enabled.
//
// Env contract (set by the workflow):
//   - PERF_PR_NUMBER      PR number to comment on (skip comment if unset)
//   - PERF_GATE           '1' to fail-the-job on regressions, '0' (or
//                          unset) to comment-only
//   - PERF_COMMIT_SHA     head commit SHA (for the comment footer)
//   - PERF_RUN_URL        link to the CI run (for the comment footer)
//   - PERF_BASELINE_PATH  override baseline NDJSON path (default:
//                          ./perf-baseline/baseline.ndjson)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare, formatMarkdown, parseNDJSON } from './compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..');

const RESULTS_DIR  = path.join(pluginRoot, 'perf-results');
const BASELINE_DEF = path.resolve(pluginRoot, '..', 'perf-baseline', 'baseline.ndjson');

function main() {
  const headFile = pickLatestNDJSON(RESULTS_DIR);
  if (!headFile) {
    console.log('[perf-compare] no head NDJSON in perf-results/ — was the bench skipped? Exiting cleanly.');
    return 0;
  }
  const headText = fs.readFileSync(headFile, 'utf8');
  /** @type {import('./compare.mjs').PerfRecord[]} */
  const head = parseNDJSON(headText);
  console.log(`[perf-compare] head: ${path.basename(headFile)} (${head.length} buckets)`);

  const baselinePath = process.env.PERF_BASELINE_PATH ?? BASELINE_DEF;
  let base = [];
  let baselineSha;
  if (fs.existsSync(baselinePath)) {
    const baseText = fs.readFileSync(baselinePath, 'utf8');
    base = parseNDJSON(baseText);
    console.log(`[perf-compare] baseline: ${baselinePath} (${base.length} buckets)`);
    baselineSha = readSiblingSha(baselinePath);
  } else {
    console.log(`[perf-compare] no baseline at ${baselinePath} — first run for this branch`);
  }

  const { rows, regressions } = compare(base, head);
  const gateEnabled = process.env.PERF_GATE === '1';
  const md = base.length === 0
    ? renderFirstRun(head)
    : formatMarkdown(rows, {
        commitSha:   process.env.PERF_COMMIT_SHA,
        baselineSha,
        runUrl:      process.env.PERF_RUN_URL,
        gateEnabled,
      });

  console.log('\n--- Markdown comment body ---\n' + md + '\n--- end ---\n');

  const prNumber = process.env.PERF_PR_NUMBER;
  if (prNumber) {
    upsertPrComment(prNumber, md);
  } else {
    console.log('[perf-compare] PERF_PR_NUMBER not set — skipping `gh pr comment`');
  }

  if (gateEnabled && regressions.length > 0) {
    console.error(`[perf-compare] ❌ ${regressions.length} regression(s) past tolerance — failing job (PERF_GATE=1)`);
    return 1;
  }
  return 0;
}

/**
 * Pick the most recent .ndjson file in `dir` by mtime. Returns null
 * when the dir is missing or empty (graceful "bench was skipped" path).
 */
function pickLatestNDJSON(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  if (entries.length === 0) return null;
  const sorted = entries
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return path.join(dir, sorted[0].f);
}

function renderFirstRun(head) {
  return [
    '## Phase C perf-bench diff',
    '',
    `_No baseline yet — the \`perf-baseline\` branch will be initialised on the next push to \`main\`._`,
    '',
    `Captured **${head.length} bucket(s)** in this run; once a baseline lands, future PRs will get a real diff table.`,
  ].join('\n');
}

function readSiblingSha(baselinePath) {
  const sidecar = path.join(path.dirname(baselinePath), 'baseline.sha');
  if (!fs.existsSync(sidecar)) return undefined;
  return fs.readFileSync(sidecar, 'utf8').trim();
}

/**
 * Upsert: find a previous bot comment marked with our heading and
 * edit it; otherwise post a new one. Avoids per-push comment spam
 * on long-running PRs.
 */
function upsertPrComment(prNumber, body) {
  const SENTINEL = '## Phase C perf-bench diff';

  // List existing comments, find ours by sentinel + bot author.
  const list = ghJson([
    'api',
    `repos/${repoSlug()}/issues/${prNumber}/comments?per_page=100`,
  ]);
  const ours = Array.isArray(list)
    ? list.find((c) => typeof c.body === 'string' && c.body.startsWith(SENTINEL))
    : null;

  if (ours) {
    console.log(`[perf-compare] editing existing comment ${ours.id}`);
    runGh([
      'api',
      `--method`, 'PATCH',
      `repos/${repoSlug()}/issues/comments/${ours.id}`,
      '-f', `body=${body}`,
    ]);
  } else {
    console.log(`[perf-compare] posting new comment to PR #${prNumber}`);
    runGh(['pr', 'comment', String(prNumber), '--body', body]);
  }
}

function repoSlug() {
  // GITHUB_REPOSITORY is set by every Actions runner.
  const slug = process.env.GITHUB_REPOSITORY;
  if (!slug) throw new Error('perf-compare: GITHUB_REPOSITORY not set');
  return slug;
}

function runGh(args) {
  const r = spawnSync('gh', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} exited ${r.status}`);
  }
}

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`[perf-compare] gh ${args[0]} failed (exit ${r.status}): ${r.stderr}`);
    return null;
  }
  try { return JSON.parse(r.stdout); }
  catch { return null; }
}

process.exit(main());
