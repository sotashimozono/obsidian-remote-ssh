// Run the previous release tag's unit tests against the current
// `plugin/src/` source.
//
// **Why:** in a normal PR, source and tests are modified together.
// If the tests are updated to "fit" a behaviour change, an
// otherwise-broken-by-the-PR invariant ships green. This replay
// catches that: the tests as they existed at the previous release
// tag are taken as a frozen contract; if any of them now fails
// against current source, either the PR is a regression OR the
// invariant is being intentionally retired (in which case the test
// goes onto the skip list with a written reason).
//
// **Scope:** `plugin/tests/*.test.ts` only (the unit tier). The
// integration suite is excluded — it's heavier, has its own opt-in
// runner (`vitest.integration.config.ts`), and tends to hit
// transient infra (sshd, workspaces) that's not what we're trying
// to pin. A future variant can cover integration replay separately.
//
// **Usage:**
//   - CI:    `.github/workflows/replay.yml` (advisory, PR only)
//   - Local: `npm run test:replay` (from `plugin/`)
//
// **Skip list:** `.github/replay-skip.txt` at repo root. One
// relative path per line (relative to `plugin/tests/`), with a
// `# reason / PR ref` comment on the same line. Empty / comment-
// only lines ignored. See the file's header for the full format.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..');

const REPLAY_DIR = path.join(pluginRoot, 'tests-replay');
const SKIP_LIST = path.join(repoRoot, '.github', 'replay-skip.txt');

/** Run a command, exit on non-zero. Captures stdout for `git` queries. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    cwd: opts.cwd ?? repoRoot,
    shell: false,
  });
  if (r.status !== 0) {
    if (opts.softFail) return null;
    process.exit(r.status ?? 1);
  }
  return opts.capture ? r.stdout.trim() : '';
}

/** `git describe` against `origin/main` so PR branches replay against
 *  the most recent **published** tag, not whatever happens to be
 *  reachable from the PR's HEAD (which on a PR that bumps the
 *  version would otherwise be the bump itself). */
function findPreviousTag() {
  // Prefer origin/main; fall back to local tag list if origin isn't
  // wired (e.g. shallow clone in some CI configs).
  const fromOrigin = run('git', ['describe', '--tags', '--abbrev=0', 'origin/main'], {
    capture: true,
    softFail: true,
  });
  if (fromOrigin) return fromOrigin;
  return run('git', ['describe', '--tags', '--abbrev=0'], { capture: true });
}

/** Read `.github/replay-skip.txt` into a Set of relative paths.
 *  Lines without a `#` reason comment are rejected — the format is
 *  meant to be self-documenting. */
function readSkipList() {
  if (!fs.existsSync(SKIP_LIST)) return new Set();
  const lines = fs.readFileSync(SKIP_LIST, 'utf8').split(/\r?\n/);
  const skips = new Set();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const hash = line.indexOf('#');
    if (hash < 0) {
      console.error(
        `replay-skip.txt: missing '# reason' comment on line: "${line}"\n` +
        `Each entry must explain why the test is being dropped.`,
      );
      process.exit(1);
    }
    const pathPart = line.slice(0, hash).trim();
    if (pathPart) skips.add(pathPart);
  }
  return skips;
}

/** Recursively copy a directory, dropping any paths in the skip
 *  set. Returns the count of `*.test.ts` files actually copied so
 *  a misconfigured skip glob (= "skipped everything") is visible
 *  in the log.
 *
 *  We copy the **entire** tests tree — including `integration/` —
 *  rather than skipping integration at the dir level here, because
 *  some top-level unit tests import helpers physically located
 *  under `integration/helpers/` (e.g. `assertSyncReflect`,
 *  `perfAggregator`). Stripping the directory would break those
 *  imports at module-resolution time. The integration **tests**
 *  themselves are excluded from execution by
 *  `vitest.replay.config.ts`'s `exclude` glob, so they don't run
 *  even though their helpers are present. */
function copyTests(src, dest, skips) {
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  const walk = (relDir) => {
    const absSrc = path.join(src, relDir);
    const absDest = path.join(dest, relDir);
    fs.mkdirSync(absDest, { recursive: true });
    for (const entry of fs.readdirSync(absSrc, { withFileTypes: true })) {
      const rel = path.posix.join(relDir.replaceAll(path.sep, '/'), entry.name);
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isFile()) {
        if (skips.has(rel)) {
          console.log(`replay: skipping ${rel} (in replay-skip.txt)`);
          continue;
        }
        fs.copyFileSync(path.join(absSrc, entry.name), path.join(absDest, entry.name));
        if (rel.endsWith('.test.ts')) copied += 1;
      }
    }
  };
  walk('');
  return copied;
}

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  // `maxRetries` + `retryDelay` smooth over Windows + cloud-sync
  // (Dropbox / OneDrive) races where a recently-closed file handle
  // hasn't been released yet, which surfaces as `EPERM` on `rmSync`.
  // `force: true` already swallows ENOENT; the retries cover EPERM /
  // EBUSY on slow filesystems.
  //
  // We swallow any leftover error: cleanup failure must not mask the
  // test result. The replay scratch dir is gitignored, so a leftover
  // tree only inconveniences the next run (which `rmrf`s upfront);
  // it never escapes into the working tree's tracked state.
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    console.warn(`replay: cleanup of ${target} failed (${e.code ?? 'unknown'}); leaving in place`);
  }
}

function main() {
  const tag = findPreviousTag();
  if (!tag) {
    console.error('replay: could not resolve a previous tag — repo has no tags?');
    process.exit(1);
  }
  console.log(`replay: baseline tag = ${tag}`);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  rmrf(REPLAY_DIR);

  let exitCode = 0;
  try {
    run('git', ['worktree', 'add', '--detach', worktree, tag]);
    const skips = readSkipList();
    const srcTests = path.join(worktree, 'plugin', 'tests');
    if (!fs.existsSync(srcTests)) {
      console.error(`replay: tag ${tag} has no plugin/tests/ — nothing to replay`);
      return;
    }
    const copied = copyTests(srcTests, REPLAY_DIR, skips);
    console.log(`replay: copied ${copied} unit-test file(s) from ${tag}`);
    if (copied === 0) {
      console.error('replay: 0 test files copied — skip list mis-configured?');
      exitCode = 1;
      return;
    }

    // Run vitest with the replay-only config. The default
    // `vitest.config.ts` pins `include: tests/**/*.test.ts`, which
    // doesn't match `tests-replay/`; the dedicated replay config
    // narrows discovery to that directory exclusively. Inherits
    // stdio so the user sees vitest's normal output.
    const vitestBin = path.join(pluginRoot, 'node_modules', 'vitest', 'vitest.mjs');
    const result = spawnSync(process.execPath, [
      vitestBin, 'run', '--config', 'vitest.replay.config.ts',
    ], {
      cwd: pluginRoot,
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0) {
      console.error(
        `\nreplay: tests from ${tag} failed against current plugin/src/.\n` +
        `Either fix the regression, or — if the invariant is being\n` +
        `intentionally retired — append the failing test path(s) to\n` +
        `.github/replay-skip.txt with a "# reason / PR ref" comment.`,
      );
      exitCode = result.status ?? 1;
    } else {
      console.log(`\nreplay: ${tag}'s tests pass against current source.`);
    }
  } finally {
    // Always clean up so a re-run doesn't trip on a stale worktree.
    run('git', ['worktree', 'remove', '--force', worktree], { softFail: true });
    rmrf(worktree);
    rmrf(REPLAY_DIR);
  }
  process.exit(exitCode);
}

main();
