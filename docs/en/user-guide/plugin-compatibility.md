---
title: Plugin compatibility
tags: [user-guide, plugins, compatibility]
description: "Which Obsidian community plugins work cleanly with obsidian-remote-ssh's shadow vault model. Known-good, known-broken, and quirky-but-fixable plugin behaviours."
---

# Plugin compatibility

How well each Obsidian community plugin holds up when the vault is
served by `obsidian-remote-ssh`. Updated as we test in the dev vault.

## How to read this table

The plugin patches `app.vault.adapter` and routes filesystem calls
through the remote daemon. A plugin **works** if every operation
that touches vault files goes through `app.vault.read / write / list /
watch / getResourcePath`. A plugin **breaks** if it bypasses those —
typically by importing Node's `fs` directly, by reading
`app.vault.adapter.basePath` and joining file paths against it, or by
using internal Obsidian APIs we don't intercept.

We can usually predict each plugin's status from its access pattern
without running it; the **Status** column distinguishes:

| Status | Meaning |
|---|---|
| ✅ verified | smoke-tested in the dev vault, the typical workflow works |
| 🟡 expected | architectural read says it should work, not yet smoke-tested |
| ⚠️ degraded | works but has a known UX problem (latency, full-vault reads, etc.) |
| ❌ broken | known to bypass the patched adapter; remote vault unreachable |
| ❔ unknown | haven't looked at the source / haven't tested |

Numbers in the table reflect a `~/work/VaultDev`-class remote
(SSH RTT under ~30 ms, vault under a few hundred files).

## Compatibility matrix

| Plugin | Access pattern | Status | Notes |
|---|---|---|---|
| Dataview | reads every MD file via `app.vault.cachedRead` for the index, then queries against `app.metadataCache` | ✅ verified-by-harness (#124 F11) | Initial index build does N reads on connect. ReadCache absorbs subsequent queries. Watch for noticeable startup delay on bigger vaults. F11 harness scenario (`plugin/tests/compat/dataview.test.ts`) drives `dv.pages()`-shape queries against a 5-page fixture and asserts frontmatter scalars + aggregations round-trip through `metadataCache.getFileCache()`. |
| Templater | reads templates from a configured folder, evaluates JS, writes through `app.vault.modify` / `create`. `tp.file.path(false)` and the `child_process.exec` cwd path read `adapter.basePath`. | ✅ verified-by-harness (#124 F12) | `vault.create` / `vault.modify` round-trips — F12 harness (`plugin/tests/compat/templater.test.ts`) drives `tp.file.create_new` against 3 fixtures and asserts frontmatter round-trips via `metadataCache`. #170 makes `tp.file.path(false)` / `exec` cwd non-`undefined`, but a JS user script using Node `fs` only sees the local shadow copy — those writes don't reach the remote (#429). |
| Kanban | stores boards as MD files with YAML frontmatter; standard vault read/write on every drag. Clipboard image paste joins `(adapter as any).basePath` with the attachment path and calls `fs.copyFile`. | 🟡 expected (smoke pending after #170) | Each card move = 1 write (vault API → round-trips; latency may lag big boards). Clipboard image paste uses `fs.copyFile` → local shadow copy only, doesn't reach the remote (#429). |
| Thino | reads/writes daily-note-style files; standard vault API | 🟡 expected | Pure vault API user. No special concerns. |
| Commander | UI plugin: ribbon icons, hotkeys, command macros. Doesn't touch vault files for its own state (uses plugin data via `loadData`/`saveData`, which goes through the patched adapter) | 🟡 expected | If a custom command invokes a different plugin, the wrapped plugin's compatibility applies. |
| Emoji Shortcodes | pure UI typing helper. No filesystem access | ✅ verified-by-architecture | Not affected by adapter patching at all. |
| Heatmap Calendar | reads MD files to count occurrences, aggregates frontmatter | 🟡 expected (similar to Dataview) | Heavy first-pass read on connect. ReadCache mitigates re-renders. |
| Meta Bind | input bindings on YAML / inline frontmatter; reads / writes via vault API | 🟡 expected | Each input change writes the host note. Latency is noticeable but functional. |
| Omnisearch | full-text indexer: reads every file in the vault on init + on changes | ⚠️ degraded (expected) | This is the most network-bound plugin in the list. Initial index build on a remote vault can take seconds-to-minutes depending on size. After the warm cache, queries are local. Recommendation: only enable Omnisearch when the connection is stable. |
| QuickLatex | renders LaTeX inline. Pure UI, no FS access | ✅ verified-by-architecture | Not affected. |
| Importer | converts external formats (Evernote `.enex`, etc.) to MD using `path.join(getBasePath(), folder.path)` as `outputDir` for the Yarle Evernote converter (Node `fs.writeFile`) | 🟡 expected (smoke pending after #170) | Yarle converter writes via Node `fs` → local shadow copy only, doesn't reach the remote (#429). To import to a remote vault, convert in a local vault and move the result over. |
| Copilot | reads `getBasePath?.()` then falls back to `basePath` for local-context AI indexing (`src/miyo/miyoUtils.ts`) | 🟡 expected (smoke pending after #170) | Either form now resolves to the shadow-vault local root via #170, so Copilot's local-context indexing operates against the synced copy. The remote is the source of truth; the index reflects whatever has been mirrored to the shadow dir. |
| Git (Vinzent03) | desktop hardcodes `SimpleGit` (spawns local `git` against `getBasePath()`); mobile uses `IsomorphicGit` via `MyAdapter(vault.adapter)` (pure JS, no shell-out) | ❌ broken on desktop / fixable upstream | The desktop path silently mis-routes commits to the shadow git repo, not the remote. The isomorphic-git path *would* work transparently against our remote adapter but is gated behind `Platform.isDesktopApp` with no toggle. **We won't ship a workaround** — see [#150](https://github.com/sotashimozono/obsidian-remote-ssh/issues/150) for the rationale. Users wanting git on a remote vault should use the integrated terminal pane ([#149](https://github.com/sotashimozono/obsidian-remote-ssh/issues/149)) or file a feature request at Vinzent03/obsidian-git for a `forceIsomorphicGit` toggle. |
| Excalidraw | drawings stored as `.excalidraw.md` (JSON) or embedded markdown; embedded images go through `getResourcePath`. `pathToFileURL(adapter.basePath)` is used as a vault-membership prefix check (`src/utils/fileUtils.ts:343`). | ✅ verified-by-harness (#124 F13) | The `RPC` transport is required for the ResourceBridge to serve images. On `SFTP` transport, embedded images fall back to a broken `data:` URL. First read of a large `.excalidraw.md` pulls the whole JSON; subsequent edits stream cleanly. After #170 the prefix check stays internally consistent (both sides see the shadow path). F13 harness scenario (`plugin/tests/compat/excalidraw.test.ts`) covers `.excalidraw.md` text round-trip + binary attachment CRUD with byte-exact equality on a 1 KB cyclic blob and a 4 KB PNG-magic + xorshift32 payload. |
| Remotely Save | `getBasePath().split("?")[0]` as a vault-instance ID for cloud-sync conflict detection (`src/main.ts:1736`) | 🟡 expected | Shadow-vault path is fine: gives a stable per-machine ID after #170. Cloud-sync semantics aren't affected. |
| Tasks | scans `metadataCache.getFileCache(file).listItems` across every markdown file for `- [ ]` checkboxes; aggregates open / done counts | ✅ verified-by-harness (#124 F14) | Pure `metadataCache` reader, no `basePath` access. F14 harness scenario (`plugin/tests/compat/tasks.test.ts`) drives the per-file aggregation against a 10-file fixture vault (mixed open/done counts, frontmatter-tagged entries, empty/no-task negative-controls) and asserts vault-wide totals (18 open / 16 done / 34 total / 8 with-tasks) plus DataviewJS-shape filters (project-tag, completion ratio, top-3 by open count). |

## Updating this table

When you actually exercise a plugin in the dev vault:

1. Connect to the remote, patch the adapter (auto-patch is on by default).
2. Enable the plugin.
3. Run the operations listed under **What to test** below for that
   plugin.
4. Move the row's status from 🟡 / ❔ to ✅ if it worked, or ❌ /
   ⚠️ if it didn't, with a one-line note about what failed and what
   you saw in `<vault>/.obsidian/plugins/remote-ssh/console.log`.

## What to test (per plugin)

Quick smoke checklists. None of these are exhaustive — the goal is to
catch the obvious "the plugin doesn't see remote files" or "the plugin
fights the adapter" failure modes.

### Dataview
- [ ] First connect: open a note that has a `dataview` block — does it
      render?
- [ ] Modify a referenced note from a different machine, watch the
      block re-render after the fs.changed → reconcile cycle.

### Templater
- [ ] Insert a template that runs a JS user function. Does it execute?
- [ ] Templates that read another vault file (via `tp.file.find_tfile`):
      do they resolve?

### Kanban
- [ ] Create a new board, drag cards between lanes, save. Does the
      `.md` on the remote update?
- [ ] Reload the vault — board state intact?

### Excalidraw
- [ ] Create a new drawing. Does the `.excalidraw.md` land on the
      remote?
- [ ] Embed an image — does the image render in the canvas? (Requires
      RPC transport.)

### Thino
- [ ] Add a quick note, check the daily file on the remote.
- [ ] Edit a past entry; does the modification land?

### Commander
- [ ] Bind a custom command to a hotkey. Does invoking it work? (No
      vault-side test required since Commander itself doesn't touch
      the FS.)

### Heatmap Calendar
- [ ] Render a heatmap of notes-per-day. Does it count correctly on
      first load?
- [ ] Modify a few past notes; does the heatmap refresh?

### Meta Bind
- [ ] Place a `meta-bind` input in a note, change its value, confirm
      the host note's frontmatter updates on the remote.

### Omnisearch
- [ ] Trigger a search. Note startup time on initial index build.
- [ ] Re-search; should be fast (hits the local index).
- [ ] After remote-side edits, are new files findable within ~30 s?

### QuickLatex
- [ ] Render an inline math formula. (No vault-side test required.)

### Emoji Shortcodes
- [ ] Type `:smile:` in a note, expect the emoji to expand. (No
      vault-side test required.)

## Known footguns (cross-plugin)

Things that aren't a specific plugin but trip plugins in general:

- **`app.vault.adapter.basePath` and `getBasePath()`** resolve to the
  **shadow vault's** local root (e.g. `~/.obsidian-remote/vaults/<P-id>/`),
  not the remote SSH path; #170 patches both so readers don't crash on
  `undefined`. The vault tree there is **virtual** — served from the
  remote, not mirrored to disk (only `.obsidian/` lives there) — so the
  two directions are **not** symmetric:
  - **Writes propagate.** A file written under `basePath` with Node
    `fs` — by a plugin, or by a subprocess it spawned — is picked up by
    a filesystem watcher and pushed to the remote vault through the
    same adapter the vault API uses, then registered in `vault.fileMap`
    (#429). It goes through the normal mtime precondition, so a
    simultaneous remote edit raises the usual conflict prompt. The
    config tree (`.obsidian/**`), `.trash`, VCS/dependency dirs and
    editor temp files are excluded; a file over the write-back size
    limit (Settings → Advanced, 32 MB default) is reported rather than
    pushed. The whole behaviour is switchable: *Push out-of-band file
    writes to the remote*.
  - **Reads work from inside Obsidian, on demand.** `readFileSync`,
    `readdirSync`, `existsSync`, `statSync` and `lstatSync` — plus the
    promise forms `fs.promises.readFile / readdir / stat / lstat /
    access`, which is the same object `require('fs/promises')` returns —
    are taken over *for paths under the vault folder only*; the config
    dir and everything outside the vault run the stock function
    untouched. Callback-style async `fs` is not patched.
    Names and sizes are answered from the vault model, so listing or
    stat-ing the vault costs **no download at all**.
    Content is where the two halves differ:
    - `fs.promises.readFile` fetches the file on demand — that read *is*
      the request.
    - `fs.readFileSync`, and the paths from `getFullPath` /
      `getFilePath`, resolve only for a file whose bytes are already
      here: one opened or written this session, or already materialised.
      **A synchronous call cannot fetch from the remote**, and the
      tempting shortcut is a trap: the localhost bridge that serves
      vault content runs on the same event loop as the plugin code, so
      blocking on a request to it deadlocks the thread that would answer
      it. Reach for the promise API when the file may not have been read
      yet.
    The note tree is still **not** mirrored: that would be a local clone
    of the remote vault, which is what this design exists to avoid. The
    cache is bounded (Settings → Advanced, *On-demand file cache*,
    128 MB default, 8 MB per file), evicts least-recently-used copies,
    refuses anything over the limit rather than fetching and discarding
    it, and is deleted on disconnect. A file over that limit reads as
    `ENOENT`, exactly as before.
    Two things this cannot reach, both moot if you switch off *Let
    plugins read the vault with filesystem calls*:
    - a plugin that captured the function before we patched it —
      `const { readFileSync } = require('fs')` at module scope;
    - **anything in another process.** A subprocess (a CLI the plugin
      spawns, `git`, `ripgrep`, an external editor) has its own `fs` and
      sees only what is physically on disk: the config tree plus
      whatever has been materialised. Point such a tool at specific
      files rather than expecting it to walk the vault.
  See *Direct-disk / agentic plugins* (#429) and the
  **basePath survey** (#133) — its "syncs up to the remote" mitigations
  now hold for writes, and only for writes. **Exception:** plugins that shell out to a local
  binary (notably obsidian-Git's `SimpleGit` desktop path) operate on
  the shadow git repo rather than the remote one — patching can't fix
  this from our side. obsidian-Git's bundled `IsomorphicGit` mode
  *would* work transparently against our adapter but is gated to
  mobile-only by the upstream; see the table row on line 46 for the
  user-facing recommendation.
- **Worker threads** spawned by plugins are independent JS contexts —
  they don't see our patched `app.vault.adapter`. Plugins that pass file
  paths to a worker for parsing (some search-heavy plugins do this)
  will break against the remote. Same diagnosis: no general fix.
- **`fs.watch` from Node** doesn't see remote activity. Our patched
  adapter feeds `app.vault.adapter.on('modify', …)`-style listeners
  through the daemon's `fs.watch` notifications, but a plugin that
  installs its own `fs.watch` against `basePath` only sees local disk
  events — its own writes and other out-of-band writers, never a change
  another device made on the remote.
- **Static asset URLs (`app://local/<path>`)** — a few plugins build
  these manually instead of going through `getResourcePath`. The
  manually-built URL points at the local FS and won't render. The
  ResourceBridge fixes this only when `getResourcePath` is the
  entry point. The `app://local` URL survey (#174, 2026-05-01)
  found **zero usage across all top-20 plugins**; only niche
  image-processing plugins outside the top-20 use this pattern
  (see survey section below). No webview-side URL rewriting is
  needed at this time.
- **Direct-disk / agentic plugins** (e.g. Claude Code wrappers like
  "Claudian") write via Node `fs` / child processes, bypassing the
  adapter ([#429](https://github.com/sotashimozono/obsidian-remote-ssh/issues/429)).
  The files they *create or edit* now reach the remote vault and the
  file explorer, via the write-back watcher described above — a
  one-way, event-driven push, not a reconciler. Reading works too, as
  long as it happens **in Obsidian's own process**: the patched `fs`
  answers listings from the vault model and fetches a file's content
  when it is read. What such a plugin hands to a *subprocess* is the
  gap — Claude Code, `git` and friends run with their own `fs` and see
  only what is physically on disk. Point them at specific files (the
  path from `getFullPath` is real by the time you get it) rather than
  letting them discover the vault by walking `basePath`.

## Why we can't auto-test all of this

Every plugin lives in its own JS context with its own internal state,
and the meaningful failures only surface in interactive use ("I
clicked X and it didn't render"). A unit-test approximation would
exercise our adapter, not the plugin's actual code path. So this doc
is maintained by hand from manual smoke testing — when something
unexpected breaks, please update the row.

## basePath compat survey (#133, 2026-04-29)

Investigation tracker for issue #133. We surveyed the top-20
most-installed community plugins (sorted by lifetime downloads from
`obsidianmd/obsidian-releases`'s `community-plugin-stats.json` on
2026-04-29) for direct reads of `app.vault.adapter.basePath` /
`getBasePath()`. The goal is to decide what `basePath` should return
on a remote vault — the issue is **investigation only**; no code
changes ship with this survey.

### Headline

- **6 / 20** plugins read `basePath` (or the equivalent
  `getBasePath()` method) from the adapter.
- **3 are high-risk** (`fs-read`): Templater, Kanban, Importer.
- **1 is incompatible without an upstream change**: Git (Vinzent03)
  hardcodes `SimpleGit` (shells out to local `git`) on desktop. Its
  bundled `IsomorphicGit` path uses a `vault.adapter` wrapper and
  would work against our remote adapter, but the gating
  (`Platform.isDesktopApp`) has no toggle. Tracked in [#150](https://github.com/sotashimozono/obsidian-remote-ssh/issues/150)
  as won't-do; see table row on line 46.
- The method form `getBasePath()` is more common in real usage than
  the property `.basePath` (Templater, Importer, Copilot, Remotely
  Save, Git all prefer it). **Both must be patched** if we ship a fix.

### Per-plugin findings

Categories: `none` (no usage), `display-only` (UI / metadata),
`fs-read` (joined and passed to Node `fs`), `fs-stat`, `passthrough`
(handed back to a patched adapter method), `other` (URL prefix
compare, child-process cwd, etc.).

| Plugin | Installs | Where | Category | Risk | Mitigation |
| --- | --- | --- | --- | --- | --- |
| Excalidraw | 5.9M | `src/utils/fileUtils.ts:343` — `pathToFileURL(adapter.basePath)` for drag-drop "is this file in the vault?" prefix-match | other | medium | Shadow-vault path keeps the prefix check internally consistent |
| Templater | 4.2M | `InternalModuleFile.ts:256/262` — `tp.file.path(false)` joins `basePath` with the target path; `UserSystemFunctions.ts:23` uses it as `child_process.exec` cwd | fs-read + exec cwd | high | Patch `basePath`/`getBasePath()` to return shadow-vault path; user scripts run against the synced shadow copy |
| Dataview | 4.1M | none in plugin source (only hit was a bundled `hot-reload` dev tool) | none | none | n/a — uses `metadataCache` only |
| Tasks | 3.4M | none in plugin source | none | none | n/a |
| Advanced Tables | 2.8M | none | none | none | n/a |
| Calendar | 2.6M | none | none | none | n/a |
| Git (Vinzent03) | 2.5M | `src/main.ts:466` — `path.join(getBasePath(), filePath)` for `electron.shell.showItemInFolder`; `simpleGit.ts:44` uses `getBasePath()` as `simple-git` `baseDir` (spawns local `git`); `gitManager/myAdapter.ts:10-37` wraps `vault.adapter` for `IsomorphicGit` (mobile-only path) | fs-read + child-process | high (fixable upstream) | `SimpleGit` (desktop) shells out to local `git` against a local path; patching `basePath` would silently mis-route. `IsomorphicGit` (mobile, gated `Platform.isDesktopApp`) routes through `vault.adapter` and would work transparently against our remote adapter — but the gating has no toggle. We won't ship a workaround; see [#150](https://github.com/sotashimozono/obsidian-remote-ssh/issues/150) and table row on line 46 |
| Style Settings | 2.3M | none | none | none | n/a |
| Kanban | 2.2M | `src/components/Item/helpers.ts:450` — `(adapter as any).basePath` joined with attachment path, fed to `fs.copyFile` on Electron clipboard image paste | fs-read | high | Patch returns shadow-vault path; `fs.copyFile` lands in shadow vault and syncs up |
| Iconize | 2.0M | none | none | none | n/a |
| Remotely Save | 1.9M | `src/main.ts:1736` — `getBasePath().split("?")[0]` as a vault-instance ID for cloud-sync conflict detection | display-only | low | Shadow-vault path is fine; gives a stable per-machine ID |
| QuickAdd | 1.7M | none | none | none | n/a |
| Minimal Theme Settings | 1.5M | none | none | none | n/a |
| Omnisearch | 1.4M | none | none | none | n/a |
| Editing Toolbar | 1.4M | none | none | none | n/a |
| Copilot | 1.3M | `src/miyo/miyoUtils.ts:105-110` — defensive `getBasePath?.()` then `basePath` fallback; flows into local-context AI machinery | passthrough | medium | Shadow-vault path lets Copilot index the synced local copy |
| Importer | 1.2M | `src/formats/evernote-enex.ts:34` — `path.join(getBasePath(), folder.path)` as `outputDir` for the Yarle Evernote converter (Node `fs` writes) | fs-read | high | Same shape as Kanban; shadow-vault path lands writes in the synced copy |
| Outliner | 1.2M | none | none | none | n/a |
| Homepage | 1.1M | none | none | none | n/a |
| Recent Files | 1.0M | none | none | none | n/a |

### Recommendations

- **Patch both `basePath` (getter) and `getBasePath()` (method)** to
  return the shadow-vault local path. This single change makes
  Templater, Kanban, Importer, and Copilot work transparently —
  `path.join(basePath, …)` plus Node `fs.*` writes land in the shadow
  vault, which the file-watcher syncs up to the remote.
- **Returning the shadow-vault path is also safe for the
  display/metadata cases** (Excalidraw URL-prefix compare, Remotely
  Save instance ID): both want a stable, internally consistent local
  path, which the shadow-vault path provides.
- **obsidian-Git is the one casualty** — desktop hardcodes `SimpleGit`,
  which shells out to a local `git` binary, so even with `basePath`
  patched it would operate on the shadow vault rather than the
  canonical remote one. obsidian-Git's bundled `IsomorphicGit` path
  *does* go through `vault.adapter` and would work against our remote
  adapter transparently, but it's gated `Platform.isDesktopApp` with
  no toggle. We won't ship a workaround (see [#150](https://github.com/sotashimozono/obsidian-remote-ssh/issues/150));
  users who want git on a remote vault should use the integrated
  terminal pane ([#149](https://github.com/sotashimozono/obsidian-remote-ssh/issues/149)).
- **14 / 20 top plugins read no `basePath` at all**, so the blast
  radius of the current "do nothing" stance is ~30% of the most-
  installed plugins. That is too large to ignore but small enough
  that a single uniform patch (no per-plugin shim layer) is the
  high-leverage choice.
- **Next step is a follow-up implementation issue**, not a change in
  this PR. Scope: extend `PATCHED_METHODS` (`plugin/src/main.ts:49`)
  to include `basePath` and `getBasePath`, route both to the shadow
  vault's local root, and add an `app://local/<path>` rewrite check
  for plugins that build asset URLs by hand from `basePath` (out of
  scope of this survey but worth keeping on the radar).

### Implementation status (2026-04-30)

- **#170 (this PR)** ships the survey's primary recommendation.
  `PATCHED_METHODS` now includes `basePath` and `getBasePath`, both
  routing to the shadow-vault local root captured at patch time from
  the host `FileSystemAdapter.getBasePath()`. `AdapterPatcher` was
  extended to handle property-getter members (the previous
  function-only path didn't cover the `basePath` accessor).
- **#174** tracks the separate `app://local/<path>` URL-rewrite
  follow-up; out of scope for #170.
- **Smoke verification** of Templater / Kanban / Importer / Copilot
  in a real dev vault remains a manual step; the matrix above keeps
  these at `🟡 expected (smoke pending after #170)` until run.

> **⚠️ Correction (2026-06-30, #429).** The "syncs up to the remote"
> mitigations below assumed a shadow→remote file-watcher that was
> **never built** for the vault tree (the only local→remote watcher is
> `SharedConfigWatcher`, `.obsidian/`-only, #342/#434). #170 made
> `basePath` *return* the local root (stops `undefined` crashes) but
> created no mirror or sync path — `fs` writes stay local (#429). Read
> "fixed by #170" as "no longer crashes," not "round-trips."

### Method

- Registry source: `community-plugins.json` +
  `community-plugin-stats.json` from `obsidianmd/obsidian-releases`,
  fetched 2026-04-29.
- Top-20 selected by lifetime `downloads` desc.
- Per-repo search: GitHub code-search API restricted to TS/JS
  sources; matches inside bundled `hot-reload` dev tools or
  `sample_vault/.../main.js` test fixtures were excluded.
- One-to-two representative usage sites recorded per plugin —
  exhaustive coverage was not the goal; the categorization is what
  drives the recommendation.

## `app://local` URL survey (#174, 2026-05-01)

Investigation tracker for issue #174. We surveyed the same top-20
plugin set for manual construction of `app://local/<path>` URLs —
the Electron protocol that Obsidian uses to serve local vault assets.
Plugins that build these by hand (instead of calling
`getResourcePath`) bypass the ResourceBridge and render broken
images on a remote vault.

### Headline

- **0 / 20** top plugins construct `app://local` URLs by hand.
- Dataview mentions the protocol in its CHANGELOG / docs only (no
  runtime code).
- The pattern exists **only in niche image-processing plugins**
  outside the top-20 (see below).

### Top-20 results

| Plugin | Installs | `app://local` in source? |
| --- | --- | --- |
| Excalidraw | 5.9M | no |
| Templater | 4.2M | no |
| Dataview | 4.1M | no (docs only) |
| Tasks | 3.4M | no |
| Advanced Tables | 2.8M | no |
| Calendar | 2.6M | no |
| Git (Vinzent03) | 2.5M | no |
| Style Settings | 2.3M | no |
| Kanban | 2.2M | no |
| Iconize | 2.0M | no |
| Remotely Save | 1.9M | no |
| QuickAdd | 1.7M | no |
| Minimal Theme Settings | 1.5M | no |
| Omnisearch | 1.4M | no |
| Editing Toolbar | 1.4M | no |
| Copilot | 1.3M | no |
| Importer | 1.2M | no |
| Outliner | 1.2M | no |
| Homepage | 1.1M | no |
| Recent Files | 1.0M | no |

### Outside top-20: plugins that DO use `app://local`

These were found via broad GitHub code search (`"app://local"` in
Obsidian-related TypeScript/JavaScript repos). All are niche
image-handling or export plugins:

| Plugin | File(s) | Pattern | Category |
| --- | --- | --- | --- |
| obsidian-image-toolkit | `src/util/markdowParse.ts` | URL pattern matching / parsing for image rendering | (a) URL parse — reads, not constructs |
| oz-image-in-editor | `src/util/obsidianHelper.ts`, `src/cm5/`, `src/cm6/` | Builds `app://local/` + basePath for inline image preview in editor | (b) genuine bypass |
| obsidian-marp-plugin | `src/convertImage.ts` | Resolves vault images to absolute path for Marp slide export | (b) genuine bypass |
| obsidian-bookmaster | `src/BookVault.ts` | Local book file rendering | (b) genuine bypass |
| obsidian-image-converter | `src/FolderAndFilenameManagement.ts` | Image path resolution during format conversion | (a) URL parse |

### Recommendations

- **No action needed for top-20 plugins.** The `app://local` footgun
  exists in theory but does not affect any high-install plugin.
- **A webview-side URL rewriter is not justified** at this time.
  The implementation cost (intercept `<img>`/`<video>`/`<audio>`/
  `<iframe>` requests matching `app://local/<shadow-vault-path>` and
  rewrite to ResourceBridge URL) is moderate, and the affected plugin
  set is tiny.
- **If a user reports a broken image in a specific plugin**, the
  per-plugin fix is to check whether the plugin calls
  `getResourcePath` (works via ResourceBridge) or constructs
  `app://local` by hand (broken). The latter can be patched
  plugin-side or — if the plugin is popular enough — by adding the
  webview rewriter at that point.
- **Re-survey when the top-20 list shifts** or when `app://local`
  usage increases (unlikely — Obsidian's own `getResourcePath` is
  the documented API and most plugin authors use it).

### Method

- Same top-20 set as the basePath survey (2026-04-29).
- GitHub code-search API: `"app://local" repo:<owner>/<name>`.
- Broad search (no repo filter) also run to find outside-top-20 hits;
  results filtered to Obsidian plugin repos by path and context.
- Matches in `obsidian.d.ts` type stubs, bundled `main.js` of other
  plugins committed to vault configs, and test fixtures were excluded.

## Compat harness (#124 Phase E)

The compat harness lives at `plugin/tests/compat/` and provides a
duck-typed Vault + MetadataCache for plugin-driven scenario tests
without a real Obsidian process. **Approach B** from #124 — fast,
deterministic, vitest-native.

### Files

| File | Purpose |
| --- | --- |
| `CompatVault.ts` | `CompatVault`, `CompatTFile`, `CompatTFolder`, `CompatMetadataCache`. |
| `fixtures.ts` | `loadFixtures(vault, dir)` walks `dir` for `.md` files and seeds the vault. |
| `fixtures/*.md` | 4 hand-crafted markdown fixtures (frontmatter / headings / tasks / plain). |
| `harness.test.ts` | 11 smoke tests verifying the harness itself. |

### Hot duck-type surface (the contract this harness honours)

```text
vault.getMarkdownFiles()         → TFile[] of every '.md' file
vault.getAbstractFileByPath(p)   → TFile | TFolder | null
vault.read(file)                 → text contents (Promise<string>)
vault.cachedRead(file)           → text contents (Promise<string>)
vault.create(path, data)         → TFile (Templater)
vault.modify(file, data)         → void  (Templater)
vault.createBinary(path, data)   → TFile (Excalidraw)
vault.readBinary(file)           → ArrayBuffer (Excalidraw)
vault.delete(file)               → void
vault.on / offref / trigger      → events ('create' | 'modify' | 'delete' | 'rename')
metadataCache.getFileCache(file) → CachedMetadata (Dataview, Tasks)
```

`CachedMetadata` carries `frontmatter` (YAML scalars: string / number /
boolean / null), `headings[]` (level 1-6 with text), and `listItems[]`
(checkbox tasks with `task: ' '` for open or `'x'` for done). Other
fields from `obsidian.d.ts` are intentionally omitted — they're added
when a plugin scenario asks for them.

### Adding a new scenario

1. Drop a new `<plugin>.test.ts` next to `harness.test.ts`.
2. Construct a fresh `CompatVault`, `loadFixtures(vault, fixturesDir())`.
3. Drive the plugin-equivalent calls (e.g. for Dataview: iterate
   `vault.getMarkdownFiles()` and read each `metadataCache.getFileCache(file)`).
4. Assert the expected aggregated output.
5. If the scenario hits a `vault.X` method that's not in the surface,
   add it to `CompatVault.ts` first — keep the harness adds-as-needed
   rather than mocking the entire `obsidian.d.ts`.

The roadmap in #124 covers F11 (Dataview), F12 (Templater), F13
(Excalidraw), F14 (Tasks). Each lands as a separate PR.
