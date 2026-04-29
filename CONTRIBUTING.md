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
```

A working dev vault path can be configured via `REMOTE_SSH_DEV_VAULT`
env var; `npm run build:full` then ships the plugin into that vault.

## Branch + commit convention

### Branches

- `feat/<short-name>` — new feature
- `fix/<short-name>` — bug fix
- `chore/<short-name>` — repo hygiene, dependency bumps, refactors with no user-visible change
- `docs/<short-name>` — documentation-only changes

One branch = one PR = one logical change. We squash-merge from main, so the branch's commits don't need to be pristine — but the PR title and body **do**.

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

`plugin/manifest.json`, `plugin/package.json`, and `plugin/versions.json` move together. Use the project's npm `version` script to bump all three at once:

```bash
cd plugin
npm version patch --no-git-tag-version   # 0.4.57 → 0.4.58
# (or `minor` / `major` / a literal `0.5.0`)
```

Then commit the four files alongside your code change in a single commit.

`version-check.yml` rejects any PR whose `manifest.json` version isn't strictly greater than the base branch's. If your PR sits open while another bumps main, rebase + bump again.

## Pull request etiquette

- Reuse [`.github/pull_request_template.md`](.github/pull_request_template.md) — the prompts are there for a reason.
- Add a **Test plan** checklist; mark each item once it actually passed locally.
- Run `npx tsc --noEmit -p tsconfig.json` and `npx vitest run` before pushing — CI runs them anyway, but the feedback loop is faster locally.
- For server changes, also run `go test ./...` from `server/`.
- Stack PRs are welcome — open the dependent PR with `--base <prior-branch>`. Once the prior merges, GitHub auto-rebases the dependent PR's base to `main`.

## Where things live

- **Architecture decisions** → `docs/architecture-*.md`. The shadow-vault rationale (and why the prior `reconcileFile` route was abandoned) is in `docs/architecture-shadow-vault.md`.
- **Test strategy** → `docs/testing-strategy.md`. Phase A (multi-client convergence), B (multi-OS), C (sync-latency + UI reflect) are codified there.
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

You don't usually create releases by hand; `release-on-merge.yml` watches main for `manifest.json` version changes and auto-tags.

Thanks again — and welcome.
