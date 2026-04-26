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
| Templater | reads templates from a configured folder, evaluates JS, writes through `app.vault.modify` / `create` | 🟡 expected | All access through standard vault API. JS user functions that import Node `fs` will break — that's a Templater config issue, not ours. |
| Kanban | stores boards as MD files with YAML frontmatter; standard vault read/write on every drag | 🟡 expected | Each card move = 1 write. Network latency may show as a noticeable lag on big boards; otherwise fine. |
| Excalidraw | drawings stored as `.excalidraw.md` (JSON) or embedded markdown; embedded images go through `getResourcePath` | 🟡 expected (RPC required) | The `RPC` transport is required for the ResourceBridge to serve images. On `SFTP` transport, embedded images fall back to a broken `data:` URL. First read of a large `.excalidraw.md` pulls the whole JSON; subsequent edits stream cleanly. |
| Thino | reads/writes daily-note-style files; standard vault API | 🟡 expected | Pure vault API user. No special concerns. |
| Commander | UI plugin: ribbon icons, hotkeys, command macros. Doesn't touch vault files for its own state (uses plugin data via `loadData`/`saveData`, which goes through the patched adapter) | 🟡 expected | If a custom command invokes a different plugin, the wrapped plugin's compatibility applies. |
| Emoji Shortcodes | pure UI typing helper. No filesystem access | ✅ verified-by-architecture | Not affected by adapter patching at all. |
| Heatmap Calendar | reads MD files to count occurrences, aggregates frontmatter | 🟡 expected (similar to Dataview) | Heavy first-pass read on connect. ReadCache mitigates re-renders. |
| Meta Bind | input bindings on YAML / inline frontmatter; reads / writes via vault API | 🟡 expected | Each input change writes the host note. Latency is noticeable but functional. |
| Omnisearch | full-text indexer: reads every file in the vault on init + on changes | ⚠️ degraded (expected) | This is the most network-bound plugin in the list. Initial index build on a remote vault can take seconds-to-minutes depending on size. After the warm cache, queries are local. Recommendation: only enable Omnisearch when the connection is stable. |
| QuickLatex | renders LaTeX inline. Pure UI, no FS access | ✅ verified-by-architecture | Not affected. |

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

- **`app.vault.adapter.basePath`** is still the local
  `FileSystemAdapter`'s base path — pointing at your local dev vault,
  not the remote. Plugins that join paths against `basePath` and feed
  them to Node `fs` directly will read/write *local* files, missing the
  remote vault entirely. There's no good general fix for this from our
  side; we can only document it.
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
  entry point.

## Why we can't auto-test all of this

Every plugin lives in its own JS context with its own internal state,
and the meaningful failures only surface in interactive use ("I
clicked X and it didn't render"). A unit-test approximation would
exercise our adapter, not the plugin's actual code path. So this doc
is maintained by hand from manual smoke testing — when something
unexpected breaks, please update the row.
