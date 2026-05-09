---
title: Documentation strategy & requirements
tags:
  - meta
  - contributing
  - documentation
created: 2026-05-09
status: accepted
---

> [!info] What this page is
> The single source of truth for **how documentation is built, hosted, structured, and authored** in this project. If you are adding a new page, changing the navigation, touching the docs CI workflow, or proposing a structural change, read this first.

## 1. Status

| | |
|---|---|
| Status | **Accepted** (2026-05-09) |
| Owner | @sotashimozono |
| Supersedes | — |
| Implementation phase | 0 — scaffold pending |

### Decisions confirmed

1. **Static site generator:** [Quartz v4](https://quartz.jzhao.xyz) — picked over VitePress / MkDocs / Docusaurus because the project must look and feel like a native Obsidian Publish site (graph view, backlinks, callouts, `[[wikilinks]]`, transclusions).
2. **Vault co-residence:** `docs/` is a real Obsidian vault. `.obsidian/` is committed. Authors edit pages inside Obsidian; Quartz renders the same files for the public.
3. **Languages:** **English only at launch.** Folder structure separates `en/` and `ja/` from day one so Japanese (and other locales) can be added by mirroring without URL churn.
4. **Hosting:** GitHub Pages, default `https://sotashimozono.github.io/obsidian-remote-ssh/` (the `sotashimozono.github.io` user pages repo already has its own CNAME, so the project pages URL inherits that domain automatically).
5. **CI:** GitHub Actions builds Quartz on every push and PR; main branch deploys to Pages, PRs upload a build artefact for review.

---

## 2. Goals & non-goals

### Goals

- **Look like an Obsidian native experience** — visitors should immediately recognise the Publish-style layout (left file tree, right backlinks / graph, callouts, wikilinks).
- **Make every audience self-serve** — end-users find install + troubleshooting in <60s; protocol implementers find the wire spec without reading source; security reviewers find the threat model.
- **Stay close to the code** — protocol pages are generated from `src/proto/types.ts`; settings reference is generated from `src/types.ts`. Drift is caught in CI.
- **Be PR-friendly** — every PR that changes `docs/**` gets a build that contributors can preview.
- **Survive scale** — folder structure works at 30 pages and at 300; nothing in the layout assumes a flat namespace.

### Non-goals

- **Versioned multi-release docs.** v1.x ships latest-only. If/when v2 ships and breaks compatibility, we revisit (Quartz has no first-class versioning — the likely path is a `legacy/v1` subfolder or a separate Pages deployment from a tag).
- **Search-as-a-service.** Quartz's built-in `flexsearch` is sufficient for our scale; no Algolia / Meilisearch / vector index for now.
- **WYSIWYG / form-based authoring** for non-engineers. Authors are expected to know Markdown (or use Obsidian, which is itself the WYSIWYG layer).
- **Comments / discussion threads** on doc pages. Issues in the GitHub repo are the discussion surface.

---

## 3. Audiences

| Audience | What they need | Priority |
|---|---|---|
| End user (uses the plugin) | Install, first connect, SSH key setup, troubleshooting, settings | **P0** |
| sysadmin (deploys daemon) | System requirements, daemon install/update, signing & verification | **P0** |
| Security reviewer / auditor | Threat model, crypto choices, TOFU & host-key flow, audit log | **P0** |
| Protocol implementer (alternate daemon) | RPC method spec, wire format, capability negotiation, version compatibility | **P0** |
| Plugin extension developer | Public API, event hooks, extension points | **P1** |
| Contributor (engineer) | Architecture, build, test strategy, release process | **P1** (existing assets in `docs/architecture-*.md`) |
| LLM / agent consumer | Pre-flattened doc dumps optimised for context windows | **P2** |

---

## 4. Folder structure

The vault root is `docs/`. The Quartz site builds from `docs/` and serves from `<base>/en/...`.

```
docs/                              # Quartz content root + Obsidian vault root
├── .obsidian/                     # vault settings — committed (theme, hotkeys)
├── index.md                       # language router (→ /en/)
├── en/
│   ├── index.md                   # English landing
│   ├── getting-started/
│   │   ├── installation.md
│   │   ├── first-connect.md
│   │   └── ssh-key-setup.md
│   ├── user-guide/
│   │   ├── shadow-vault-concept.md
│   │   ├── plugin-installation.md
│   │   ├── conflict-resolution.md
│   │   ├── jump-host.md
│   │   ├── terminal.md
│   │   └── troubleshooting.md
│   ├── reference/
│   │   ├── settings.md            # auto-generated from src/types.ts
│   │   ├── commands.md
│   │   ├── public-api.md
│   │   └── error-codes.md         # auto-generated from src/proto/types.ts
│   ├── protocol/
│   │   ├── overview.md
│   │   ├── handshake.md
│   │   ├── methods.md             # auto-generated from src/proto/types.ts
│   │   ├── error-envelope.md
│   │   └── compatibility-matrix.md
│   ├── architecture/
│   │   ├── shadow-vault.md        # migrated from docs/architecture-shadow-vault.md
│   │   ├── perf.md                # migrated
│   │   ├── collab.md              # migrated
│   │   ├── transport.md
│   │   ├── security.md
│   │   └── adr/                   # Architecture Decision Records
│   ├── ops/
│   │   ├── system-requirements.md
│   │   ├── daemon-deployment.md
│   │   ├── signing-verification.md
│   │   └── observability.md
│   ├── contributing/
│   │   ├── development.md
│   │   ├── testing-strategy.md    # migrated
│   │   ├── plugin-compatibility.md # migrated
│   │   ├── release-process.md
│   │   └── documentation.md       # ← this file
│   └── changelog.md               # auto-generated
├── ja/                            # populated in a future phase; structure mirrors en/
└── ai/                            # P2 — pre-flattened dumps for LLM consumption

docs-site/                         # Quartz framework — npm-installed here, not in docs/
├── quartz.config.ts
├── quartz.layout.ts
├── package.json
└── ...
```

> [!note] Why split `docs/` and `docs-site/`
> `docs/` must be a clean Obsidian vault — no `node_modules`, no build artefacts, no JavaScript. `docs-site/` holds Quartz itself (framework code, dependencies, build output). The CI workflow tells Quartz: *"`contentDirectory` is `../docs`"*.

### i18n routing

| URL | Source |
|---|---|
| `/` | `docs/index.md` — language router page |
| `/en/...` | `docs/en/...` |
| `/ja/...` (future) | `docs/ja/...` |

The root `index.md` should be a thin landing page with a language picker plus an HTTP-equiv `<meta http-equiv="refresh">` fallback to `/en/` so users without JS still arrive somewhere useful.

> [!warning] Do not put English content at root
> Even though we launch English-only, never put English pages at `docs/foo.md` — they belong at `docs/en/foo.md`. Adding `ja/` later must not require URL migrations or breaking inbound links.

---

## 5. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Site generator | Quartz v4 | TypeScript + preact + esbuild |
| Hosting | GitHub Pages | Same repo, no separate deploy account |
| Build CI | GitHub Actions | Reuses repo's existing workflow infra |
| Search | flexsearch (Quartz built-in) | Client-side, no service to host |
| Diagrams | Mermaid (Quartz built-in) | Already used heavily in existing `docs/architecture-*.md` |
| Maths | KaTeX (Quartz built-in) | Reserved for protocol notation if needed |
| Spell-check | `crate-ci/typos` (CI-only) | Project name allowlist in `_typos.toml` |
| Link-check | `lycheeverse/lychee` (CI-only) | Both internal `[[wikilinks]]` and external HTTP |
| Settings/Protocol gen | `typedoc` → markdown | Output committed under `reference/` and `protocol/` so the site builds from a clean checkout |

### Browser support

Match Quartz's defaults: latest 2 versions of Chromium / Firefox / Safari, mobile responsive. We do not test IE11 / legacy Edge. Accessibility target: **WCAG 2.2 AA** (contrast, keyboard navigation, semantic landmarks). Quartz's default theme is already AA — keep it that way when customising.

---

## 6. Hosting & URL

| Item | Value |
|---|---|
| Production URL | `https://sotashimozono.github.io/obsidian-remote-ssh/` (resolves to user's CNAME-mapped domain) |
| Pages source | `gh-pages` branch (built artefact from CI) |
| Build artefact | `docs-site/public/` |
| Custom domain | Inherited from `sotashimozono.github.io` user pages CNAME — no per-project CNAME file needed |
| Robots | Public, indexable; sitemap generated by Quartz |

> [!note] No `CNAME` file in this repo
> Putting a `CNAME` file in this repo would override the user-pages CNAME and pin a project-specific domain. Don't add one unless we move to a dedicated documentation domain.

---

## 7. Build & deploy CI

### Workflow file: `.github/workflows/docs.yml`

```yaml
name: Docs

on:
  push:
    branches: [main]
    paths: ['docs/**', 'docs-site/**', '.github/workflows/docs.yml']
  pull_request:
    paths: ['docs/**', 'docs-site/**', '.github/workflows/docs.yml']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: docs-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0       # Quartz uses git history for "last modified"
      - uses: actions/setup-node@v6
        with:
          node-version: '20'
          cache: npm
          cache-dependency-path: docs-site/package-lock.json
      - name: Install
        working-directory: docs-site
        run: npm ci
      - name: Build
        working-directory: docs-site
        run: npx quartz build
      - name: Spell-check
        uses: crate-ci/typos@master
        with:
          files: ./docs
      - name: Link-check
        uses: lycheeverse/lychee-action@v2
        with:
          args: --no-progress --exclude-mail ./docs/**/*.md
      - name: Upload artefact
        uses: actions/upload-pages-artifact@v3
        with:
          path: docs-site/public

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

### Quality gates

A docs PR must pass:

1. **Build green** — Quartz produces `public/` without warnings categorised as errors (broken transclusion, missing target, etc.).
2. **Spell-check** — `typos` against the project allowlist.
3. **Link-check** — every `[[wikilink]]` and external URL resolves.
4. **Generated content drift check** — if `src/proto/types.ts` or `src/types.ts` changed, the regenerated `protocol/methods.md` and `reference/settings.md` must match the committed copies. Stale generated files block merge.

### Preview strategy

Initial implementation: PRs upload the build artefact only (downloadable from the PR's checks page). If artefact-download friction proves real, we move to Cloudflare Pages preview deploys with PR-comment URLs (separate decision).

---

## 8. Authoring conventions

### Frontmatter (required on every page)

```yaml
---
title: Human-readable page title
tags:
  - <category>      # one of: getting-started, user-guide, reference, protocol, architecture, ops, contributing, meta
  - <topic-tag>     # optional, kebab-case
created: YYYY-MM-DD
---
```

`title` becomes the `<h1>`, the `<title>` tag, and the sidebar label. **Do not** also write a top-level `# Title` in the body — Quartz adds it automatically from frontmatter.

### Links

- **Internal links** use `[[wikilinks]]` with the page's filename, no `.md`: `[[shadow-vault-concept]]`. Quartz resolves them across the whole vault.
- **Anchor to a heading** in another page: `[[shadow-vault-concept#Goals]]`.
- **Anchor with custom text:** `[[shadow-vault-concept|Why a shadow vault?]]`.
- **External links** use standard Markdown: `[Quartz](https://quartz.jzhao.xyz)`. CI link-checks them.

### Callouts (use Obsidian syntax)

```markdown
> [!info] Optional title
> Body text. Multi-line.

> [!warning]
> Use `warning` for security-sensitive guidance, `caution` for footguns,
> `note` for nice-to-knows, `tip` for productivity hints, `example` for
> walkthroughs. Avoid inventing new types — Quartz only renders Obsidian's standard set.
```

### Code blocks

Always tag the language. For shell snippets, prefer `bash` over `sh`. For protocol examples, use `json` and include the full envelope (`jsonrpc`, `id`, `method`, `params`).

### Images

- Place under `docs/en/assets/<page-slug>/` and reference with `![[asset-name.png]]`.
- Prefer SVG for diagrams, PNG for screenshots.
- Mermaid for anything that can be expressed in text — the diagram source is then diff-able.
- Provide alt text via the wikilink-display form: `![[diagram.svg|Diagram showing the shadow vault bootstrap sequence]]`.

### Voice & terminology

- Second-person ("you set the …") for user-facing pages, third-person / imperative for reference and protocol pages.
- "Shadow vault", "source vault", "daemon", "host (vault)", "remote" — capitalise consistently per the glossary in `[[architecture/shadow-vault]]`.
- "SSH" not "ssh", "JSON-RPC" not "json-rpc / jsonrpc / JSON RPC".

---

## 9. Auto-generation strategy

Some pages must reflect source code exactly. We commit the generated output (so the site builds from a clean checkout) and regenerate via a local `npm` script + CI drift check.

| Generated page | Source of truth | Generator |
|---|---|---|
| `reference/settings.md` | `src/types.ts` (`PluginSettings` + JSDoc) | `typedoc` → `typedoc-plugin-markdown` → post-process |
| `reference/error-codes.md` | `src/proto/types.ts` (`ErrorCode` enum + JSDoc) | small TS script `scripts/gen-error-docs.mjs` |
| `protocol/methods.md` | `src/proto/types.ts` (request / response interfaces + JSDoc) | small TS script `scripts/gen-protocol-docs.mjs` |
| `changelog.md` | git tags + `CHANGELOG.md` | `git-cliff` (already configured at root) |

Each generator script is a standalone `node scripts/gen-*.mjs` runnable locally. CI re-runs them and fails if `git diff` is non-empty in the generated paths.

> [!example] Drift check (CI shape)
> ```bash
> node scripts/gen-protocol-docs.mjs
> if ! git diff --quiet docs/en/protocol/methods.md; then
>   echo "::error::protocol/methods.md is out of date — run scripts/gen-protocol-docs.mjs locally"
>   exit 1
> fi
> ```

---

## 10. Phasing roadmap

### Phase 0 — Scaffold (target: this PR series)

- [ ] Add `docs-site/` with Quartz v4, configured to read from `../docs`
- [ ] Add `.github/workflows/docs.yml`
- [ ] Add `docs/.obsidian/` with a starter theme + folder/tag visibility config
- [ ] Add `docs/index.md` (language router) and `docs/en/index.md` (landing)
- [ ] First green deploy to GitHub Pages
- [ ] This requirements doc lives at `docs/en/contributing/documentation.md` (← we are here)

### Phase 1 — Migrate existing assets

- [ ] Move `docs/architecture-shadow-vault.md` → `docs/en/architecture/shadow-vault.md`
- [ ] Move `docs/architecture-perf.md` → `docs/en/architecture/perf.md`
- [ ] Move `docs/architecture-collab.md` → `docs/en/architecture/collab.md`
- [ ] Move `docs/testing-strategy.md` → `docs/en/contributing/testing-strategy.md`
- [ ] Move `docs/plugin-compatibility.md` → `docs/en/contributing/plugin-compatibility.md`
- [ ] Rewrite root `README.md` and `CONTRIBUTING.md` so they cross-link into the new site
- [ ] Replace ad-hoc Markdown links with `[[wikilinks]]`

### Phase 2 — New user-facing content

- [ ] `getting-started/` (installation, first-connect, ssh-key-setup)
- [ ] `user-guide/troubleshooting.md` (the FAQ from existing GitHub issues)
- [ ] `reference/settings.md` (generated)
- [ ] `protocol/{overview,handshake,methods,error-envelope,compatibility-matrix}.md`
- [ ] `ops/{system-requirements,daemon-deployment,signing-verification}.md`
- [ ] `architecture/security.md` (threat model — currently absent)

### Phase 3 — Polish & expansion

- [ ] `architecture/adr/` — backfill key decisions retroactively (shadow-vault pivot, transport choice, signing model)
- [ ] `ai/` — pre-flattened LLM-friendly dumps
- [ ] `ja/` — Japanese translation begins (mirror `en/` page-by-page; track coverage)
- [ ] Search analytics → identify zero-result queries → fill content gaps

---

## 11. Open questions

> [!question] Tracked, but deferred until they bite
> 1. **Versioning.** When v2 lands with breaking changes, do we (a) snapshot v1 to `legacy-v1/` inside the same site, (b) deploy a separate Pages site from the v1 tag, or (c) accept "latest-only" and rely on git history? — Decide when v2 is on the horizon.
> 2. **Comments / feedback.** Some docs sites use Giscus / Utterances for per-page discussion. We're starting without it; revisit if we see repeated "where do I report this confusion?" patterns.
> 3. **Custom domain for docs.** Inheriting the user-pages CNAME is fine for launch. If docs traffic ever justifies a dedicated subdomain (e.g. `docs.<project>.dev`), revisit DNS + Pages CNAME.
> 4. **Mobile graph view.** Quartz's graph view is desktop-friendly but cramped on mobile. If mobile traffic dominates, consider hiding it on small viewports.

---

## 12. How to use this document

- **Adding a page?** Skim §4 (folder), §8 (frontmatter, links, callouts), commit, open PR.
- **Changing the layout / theme?** That's a §5 / §6 decision — propose a change to *this document* in the same PR.
- **Adding auto-generated reference pages?** Follow §9 — the script lives in `scripts/`, the output lives under `docs/en/reference/` or `docs/en/protocol/`, and CI gets a new drift-check step.
- **Translating a page to JA?** Mirror the `en/` path under `ja/`. Keep filenames identical so cross-language links resolve. Translation status will eventually be tracked in `docs/ja/index.md`.
