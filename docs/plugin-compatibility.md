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
| Dataview | reads every MD file via `app.vault.cachedRead` for the index, then queries against `app.metadataCache` | 🟡 expected (check on first build) | Initial index build does N reads on connect. ReadCache absorbs subsequent queries. Watch for noticeable startup delay on bigger vaults. |
| Templater | reads templates from a configured folder, evaluates JS, writes through `app.vault.modify` / `create`. `tp.file.path(false)` and the `child_process.exec` cwd path read `adapter.basePath`. | 🟡 expected (smoke pending after #170) | `basePath` now resolves to the shadow-vault local root via #170, so `tp.file.path(false)` returns a path whose `fs.readFileSync` finds mirrored content. JS user functions that import Node `fs` and write under `basePath` land in the shadow dir, which propagates to the remote. |
| Kanban | stores boards as MD files with YAML frontmatter; standard vault read/write on every drag. Clipboard image paste joins `(adapter as any).basePath` with the attachment path and calls `fs.copyFile`. | 🟡 expected (smoke pending after #170) | Each card move = 1 write. Network latency may show as a noticeable lag on big boards; otherwise fine. Clipboard paste is fixed by #170: `basePath` now resolves to the shadow-vault local root, so `fs.copyFile` lands in the shadow dir. |
| Thino | reads/writes daily-note-style files; standard vault API | 🟡 expected | Pure vault API user. No special concerns. |
| Commander | UI plugin: ribbon icons, hotkeys, command macros. Doesn't touch vault files for its own state (uses plugin data via `loadData`/`saveData`, which goes through the patched adapter) | 🟡 expected | If a custom command invokes a different plugin, the wrapped plugin's compatibility applies. |
| Emoji Shortcodes | pure UI typing helper. No filesystem access | ✅ verified-by-architecture | Not affected by adapter patching at all. |
| Heatmap Calendar | reads MD files to count occurrences, aggregates frontmatter | 🟡 expected (similar to Dataview) | Heavy first-pass read on connect. ReadCache mitigates re-renders. |
| Meta Bind | input bindings on YAML / inline frontmatter; reads / writes via vault API | 🟡 expected | Each input change writes the host note. Latency is noticeable but functional. |
| Omnisearch | full-text indexer: reads every file in the vault on init + on changes | ⚠️ degraded (expected) | This is the most network-bound plugin in the list. Initial index build on a remote vault can take seconds-to-minutes depending on size. After the warm cache, queries are local. Recommendation: only enable Omnisearch when the connection is stable. |
| QuickLatex | renders LaTeX inline. Pure UI, no FS access | ✅ verified-by-architecture | Not affected. |
| Importer | converts external formats (Evernote `.enex`, etc.) to MD using `path.join(getBasePath(), folder.path)` as `outputDir` for the Yarle Evernote converter (Node `fs.writeFile`) | 🟡 expected (smoke pending after #170) | `getBasePath()` now returns the shadow-vault local root via #170, so the converter writes files into the shadow dir; the file-watcher propagates them to the remote. Initial conversion of a large `.enex` may produce many writes; watch for queue lag. |
| Copilot | reads `getBasePath?.()` then falls back to `basePath` for local-context AI indexing (`src/miyo/miyoUtils.ts`) | 🟡 expected (smoke pending after #170) | Either form now resolves to the shadow-vault local root via #170, so Copilot's local-context indexing operates against the synced copy. The remote is the source of truth; the index reflects whatever has been mirrored to the shadow dir. |
| Git (Vinzent03) | uses `simple-git` with `getBasePath()` as the working directory; spawns the local `git` binary | ❌ broken (un-fixable at this layer) | Patching `basePath` to the shadow-vault path lets `simple-git` run, but it operates on the *shadow* git repo, not the remote one — silently mis-routing commits. A "remote git over SSH" feature would be needed (tracked in #150). |
| Excalidraw | drawings stored as `.excalidraw.md` (JSON) or embedded markdown; embedded images go through `getResourcePath`. `pathToFileURL(adapter.basePath)` is used as a vault-membership prefix check (`src/utils/fileUtils.ts:343`). | 🟡 expected (RPC required) | The `RPC` transport is required for the ResourceBridge to serve images. On `SFTP` transport, embedded images fall back to a broken `data:` URL. First read of a large `.excalidraw.md` pulls the whole JSON; subsequent edits stream cleanly. After #170 the prefix check stays internally consistent (both sides see the shadow path). |
| Remotely Save | `getBasePath().split("?")[0]` as a vault-instance ID for cloud-sync conflict detection (`src/main.ts:1736`) | 🟡 expected | Shadow-vault path is fine: gives a stable per-machine ID after #170. Cloud-sync semantics aren't affected. |

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
  not the remote SSH path. Plugins that join paths against `basePath`
  and feed them to Node `fs` directly read mirrored content and write
  into the shadow dir; the file-watcher then propagates writes back to
  the remote. This is the natural value of `FileSystemAdapter.basePath`
  in the shadow window, and #170 patches both forms onto the
  replacement adapter explicitly so the contract is stable across
  Obsidian version upgrades. See the **basePath compat survey** section
  below (#133, 2026-04-29) for the top-20 plugin survey, and #170 for
  the implementation. **Exception:** plugins that shell out to a local
  binary (notably obsidian-Git via `simple-git`) will operate on the
  shadow git repo rather than the remote one — patching can't fix this.
- **Worker threads** spawned by plugins are independent JS contexts —
  they don't see our patched `app.vault.adapter`. Plugins that pass file
  paths to a worker for parsing (some search-heavy plugins do this)
  will break against the remote. Same diagnosis: no general fix.
- **`fs.watch` from Node** doesn't reach the remote. Our patched
  adapter feeds `app.vault.adapter.on('modify', …)`-style listeners
  through the daemon's `fs.watch` notifications, but a plugin that
  installs its own `fs.watch` against `basePath` only watches the local
  empty directory.
- **Static asset URLs (`app://local/<path>`)** — a few plugins build
  these manually instead of going through `getResourcePath`. The
  manually-built URL points at the local FS and won't render. The
  ResourceBridge fixes this only when `getResourcePath` is the
  entry point. The `app://local` URL survey (#174, 2026-05-01)
  found **zero usage across all top-20 plugins**; only niche
  image-processing plugins outside the top-20 use this pattern
  (see survey section below). No webview-side URL rewriting is
  needed at this time.

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
- **1 is fundamentally incompatible** even with patching: Git
  (Vinzent03), via `simple-git` shelling out to a local `git` binary.
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
| Git (Vinzent03) | 2.5M | `src/main.ts:466` — `path.join(getBasePath(), filePath)` for `electron.shell.showItemInFolder`; `simpleGit.ts:44` uses `getBasePath()` as `simple-git` `baseDir` (spawns local `git`) | fs-read + child-process | high (un-fixable) | `simple-git` shells out to the *local* `git` binary against a *local* path; patching `basePath` to the shadow vault would silently mis-route operations. Document as known-incompatible |
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
- **obsidian-Git is the one genuine casualty** — `simple-git` shells
  out to a local `git` binary, so even with `basePath` patched it
  would operate on the shadow vault rather than the canonical remote
  one. Document as incompatible; a separate "remote git over SSH"
  feature would be the only fix.
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
