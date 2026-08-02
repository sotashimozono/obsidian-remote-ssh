# Contributing

Thanks for your interest. The project is built around a few hard
conventions that make the contribution loop predictable. Please read
this once before opening your first PR.

## Repository layout

```
plugin/    Obsidian plugin (TypeScript, esbuild, vitest)
server/    obsidian-remote-server daemon (Go, fsnotify)
proto/     Shared JSON-RPC method + error definitions (TS + Go in lockstep)
docs/      Architecture notes (shadow vault, perf, testing strategy, …)
deploy/    Turn-key sshd container (Docker compose) for trying the plugin
docker/    Test-only sshd container for the integration suite
```

See [README.md](README.md) for the user-facing story.

## Dev setup

Prerequisites:

- **Node.js 20+** for the plugin (`plugin/package.json`)
- **Go 1.25+** for the daemon (`server/go.mod`'s `go` directive)
- **Docker** for the integration test suite (optional for plugin-only changes)

```bash
# Plugin
cd plugin
npm ci
npm test                 # ~570 unit tests, ~3 s
npx tsc --noEmit         # type-check
npm run dev              # esbuild watch into <plugin>/main.js

# Server
cd server
make build               # builds bin/obsidian-remote-server (host platform)
make cross               # builds 4 platforms into dist/
go test ./...

# Full integration (Docker required)
cd plugin
npm run sshd:start
npm run test:integration
npm run sshd:stop

# Plugin-side perf bench (separate from `test:integration`)
npm run test:integration:bench

# E2E against a real Obsidian window (Playwright + CDP)
# Requires: Obsidian installed + Docker test sshd running + plugin built.
# Linux/macOS only locally; Windows is workflow-only (Xvfb-dependent).
OBSIDIAN_PATH=/path/to/obsidian npm run build && npm run sshd:start
npm run test:e2e               # all specs (smoke + sync + reflect + demo)
npm run test:e2e:reflect       # just the M11 remote-→-Obsidian reflection set
npm run sshd:stop
```

A working dev vault path can be configured via `REMOTE_SSH_DEV_VAULT`
env var; `npm run build:full` then ships the plugin into that vault.

In CI, `.github/workflows/e2e.yml` runs the suite on every open PR
that touches plugin/server/docker sources — whatever branch the PR is
based on — plus weekly (Sundays 03:00 UTC / 12:00 JST) to catch
environment drift. Trigger off-cycle from GitHub Actions → "E2E smoke
(Playwright + Obsidian)" → "Run workflow".

Note on bases: the CI gates (lint, type-check, tests, integration,
E2E, replay, commitlint, security scans) run on **any** open PR, so a
PR into a feature track such as `cli` is checked exactly like one into
`next`. The single exception is `version-check.yml`, which encodes the
`next`/`main` release model and therefore only runs on PRs into those
two branches.

## Branch + commit convention

### Branches

- `feat/<short-name>` — new feature
- `fix/<short-name>` — bug fix
- `chore/<short-name>` — repo hygiene, dependency bumps, refactors with no user-visible change
- `docs/<short-name>` — documentation-only changes

One branch = one PR = one logical change. We squash-merge, so the branch's commits don't need to be pristine — but the PR title and body **do**.

### Branching model — `next` (beta) + `main` (stable)

This repo runs a two-channel release model. Pick the right base for your PR:

| You're doing… | Base your PR on | Version shape |
|---|---|---|
| New feature / refactor / bug fix / docs / chore | **`next`** ← almost everything | `X.Y.Z-beta.N` |
| Emergency hotfix for a shipped stable release | **`next`** (fast-tracked, then promote) | `X.Y.Z` |
| Promotion of accumulated betas to stable (release cut) | **`next`** (bump to stable, then `next` → `main`) | `X.Y.Z` (suffix dropped) |

Why this exists:

- **`next`** is the **beta channel**. BRAT users (`obsidian42-brat` with this repo's slug + `--beta`) follow this branch via `manifest-beta.json` — every merge to `next` publishes a `vX.Y.Z-beta.N` GitHub Release marked as prerelease, and BRAT auto-updates them on the next launch.
- **`main`** is the **stable channel**. Each merge publishes a clean `vX.Y.Z` GitHub Release marked as the latest, which is what the Obsidian Community Plugins store + the README install link resolve to. A `sync: main → next` PR is opened and auto-merged automatically by `.github/workflows/sync-main-to-next.yml`, so the histories rejoin without manual intervention.
- The version shape is the **single source of truth** for the channel: `release.yml` reads `plugin/manifest.json` and chooses prerelease vs stable based on whether the version contains `-beta.`. `version-check.yml` enforces that the right shape lives on the right branch.

#### Cutting a promotion (next → main)

**`main` only ever merges from `next` — there is no `release/*` branch.** Bump
`next` to the stable version first (on a normal branch, PR'd **into `next`**),
then promote `next` to `main`:

```bash
# 1. Bump next to the stable version.
git checkout -b release-X.Y.Z next
cd plugin
npm run bump:stable          # 1.0.44-beta.5 → 1.0.44 (drops the -beta suffix)
git commit -am "release: X.Y.Z (stable)"
git push origin release-X.Y.Z
gh pr create --base next --head release-X.Y.Z --title "release: X.Y.Z (stable)"
```

The bump runs the full suite (commitlint, version-check, lint, type-check,
tests) on its PR **into `next`** — `version-check.yml` accepts a plain `X.Y.Z`
on `next` as a promotion-staging shape, and `release.yml` skips publishing a
stable version pushed to `next` (the `main` push is what releases). No admin
override, no separate release branch.

After it merges (`next` now carries the stable `X.Y.Z`), promote directly:

```bash
gh pr create --base main --head next --title "promote: next → main (X.Y.Z)"
```

On the main push: `release.yml` publishes **vX.Y.Z** stable + cosign-signed
binaries; `sync-main-to-next.yml` opens + auto-merges `main → next`. Because
`next` and `main` are now the **same** `X.Y.Z`, that sync has **no version
conflict** — which is exactly why the bump lives on `next` and not on a branch
that diverges from it. Then start the next cycle with `npm run bump:beta:start`
(`X.Y.Z → X.Y.(Z+1)-beta.0`) on a `feat/...` branch.

### Commit messages — Conventional Commits, enforced

Format: `type(scope): subject`

```
feat(plugin): Phase D-γ / F18 — error toast taxonomy + Notice / log integration (0.4.51)
fix(server): unbreak Go + Dockerfile after Dependabot rollups (0.4.52)
ci(release): grouped CHANGELOG via git-cliff (0.4.57)
```

- `type` ∈ `build` `chore` `ci` `docs` `feat` `fix` `perf` `refactor` `revert` `style` `test` `release`
- `scope` is free-form; common scopes: `plugin`, `server`, `proto`, `deploy`, `ci`, `release`, `security`.
- Subject can mix cases (`Phase D-γ` is fine; commitlint's `subject-case` is intentionally relaxed — see [`commitlint.config.mjs`](commitlint.config.mjs)).
- Header cap is **144 characters** (the standard 100 doesn't fit our `Phase X.Y — long subject (0.4.NN)` style).
- The `(0.4.NN)` suffix matches the version bump (see below).
- A trailing `Co-Authored-By:` line is fine; it's stripped from the auto-generated changelog (`cliff.toml` `commit_preprocessors`).

The `commitlint.yml` workflow checks every commit in the PR. A typo in commit #3 of a 5-commit PR fails the gate; please fix in-place + force-push rather than tacking on a `fix typo` commit.

### Version bumps

The version shape selects the channel: `X.Y.Z-beta.N` lives on `next`, plain `X.Y.Z` lives on `main`. Three npm scripts cover the lifecycle:

```bash
cd plugin
# Day-to-day work on next (most PRs):
npm run bump:beta            # 1.0.44-beta.3 → 1.0.44-beta.4

# First commit of a new beta cycle (after main has just absorbed
# a stable release and next == main):
npm run bump:beta:start      # 1.0.44 → 1.0.45-beta.0

# Promotion (drop the suffix; only run when ready to cut stable):
npm run bump:stable          # 1.0.44-beta.5 → 1.0.44
```

Each script:
- updates `plugin/package.json` + `plugin/manifest.json`
- updates the **right** root manifest:
  - **beta** bump → only `manifest-beta.json` (BRAT --beta consumers)
  - **stable** bump → both `manifest.json` (Obsidian Community Plugins) and `manifest-beta.json`, plus the `versions.json` compatibility map
- stages every changed file via the npm `version` lifecycle hook

Commit the staged files alongside your code change.

`version-check.yml` is **branch-aware**: beta PRs into `next` must keep `manifest.json` (root) pinned to the last stable — **except a stable promotion-staging bump (a plain `X.Y.Z` landed on `next`), which is validated with the same all-manifests-agree rule as a `main` PR**. PRs into `main` must carry a plain `X.Y.Z` (no beta suffix) with all manifests in agreement. If your PR sits open while another lands on the same base, rebase + run the same `bump:` script again.

## Pull request etiquette

- Reuse [`.github/pull_request_template.md`](.github/pull_request_template.md) — the prompts are there for a reason.
- Add a **Test plan** checklist; mark each item once it actually passed locally.
- Run `npx tsc --noEmit -p tsconfig.json` and `npx vitest run` before pushing — CI runs them anyway, but the feedback loop is faster locally.
- For server changes, also run `go test ./...` from `server/`.
- Stack PRs are welcome — open the dependent PR with `--base <prior-branch>`. Once the prior merges, GitHub auto-rebases the dependent PR's base to `next` (or `main` for stack PRs targeting the stable channel).

## Where things live

- **Architecture decisions** → `docs/en/architecture/*.md`. The shadow-vault rationale (and why the prior `reconcileFile` route was abandoned) is in `docs/en/architecture/shadow-vault.md`.
- **Test strategy** → `docs/en/contributing/testing-strategy.md`. Phase A (multi-client convergence), B (multi-OS), C (sync-latency + UI reflect) are codified there.
- **Performance numbers** → the `perf-baseline` orphan branch's `baseline.ndjson`, refreshed nightly by `bench.yml`.
- **Issue tracker** → for bug reports, feature requests, design questions.
- **Security issues** → see [SECURITY.md](SECURITY.md), **not** the public issue tracker.

## Code style

- TypeScript: `strictNullChecks: true`, `isolatedModules: true`. No ESLint config required for now (was scoped out as low-value during early development).
- Go: `gofmt -w .` (the `gosec` job in `security.yml` will flag obvious issues).
- Comments: explain **why**, not what. The codebase prefers a few generous block comments at module / class boundaries over per-line noise.
- New tests should mirror the surface they cover: `src/util/Foo.ts` ↔ `tests/Foo.test.ts`.

## Releases

Tagged releases (`X.Y.Z` format) trigger `.github/workflows/release.yml`:

1. Test gate (typecheck + vitest)
2. Server-binary build × 4 platforms + cosign keyless sign
3. Plugin bundle build + bundle-size check
4. Grouped changelog generated by `git-cliff` (`cliff.toml`)
5. GitHub Release created with all artefacts attached

You don't usually create releases by hand; `release.yml` watches both branches and selects channel by version shape — every merge to `next` publishes a `vX.Y.Z-beta.N` prerelease, every merge to `main` publishes a `vX.Y.Z` stable. See [Branching model](#branching-model--next-beta--main-stable) for the promotion flow.

Thanks again — and welcome.
