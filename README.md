# obsidian-remote-ssh

A VSCode-Remote-SSH-style experience for Obsidian: keep using your
desktop Obsidian, but the vault you edit lives on a remote SSH host.
Files, attachments, file-explorer state, search — all served from the
remote, transparently, by patching `app.vault.adapter`.

> Status: pre-release. Works end-to-end against a Linux remote when the
> daemon is staged. Dev workflow only — install into a dev vault, not
> your production vault.

## How it works

```
Obsidian (this machine)            Remote host
  app.vault.adapter ◀──── patched ──── this plugin
                                          │
                                          ▼
                              SSH session (ssh2)
                                          │
                                          ▼
                              JSON-RPC framed over a
                              forwarded unix-socket stream
                                          │
                                          ▼
                              obsidian-remote-server
                              (Go daemon, auto-deployed)
                                          │
                                          ▼
                              Vault files on the remote FS
```

- The plugin opens an SSH session via the bundled `ssh2` library.
- It uploads a tiny Go daemon (`obsidian-remote-server`) to
  `~/.obsidian-remote/` on the remote and starts it via `nohup`.
- A local Duplex stream is forwarded to the daemon's unix socket. All
  vault FS operations flow through that as length-framed JSON-RPC.
- Obsidian's `app.vault.adapter` is monkey-patched so reads, writes,
  list, watch, etc. go through the daemon instead of the local
  filesystem. To Obsidian and to most plugins it looks like the local
  vault is just unusually slow.

## Repository layout

```
plugin/    Obsidian plugin (TypeScript, esbuild, vitest)
server/    obsidian-remote-server daemon (Go, fsnotify)
proto/     Shared JSON-RPC method + error definitions (TS + Go in lockstep)
docs/      Operator notes (plugin compatibility, etc.)
```

## Install (dev)

Prerequisites: Node 20+, Go 1.22+, an SSH host you can reach from this
machine (password, key, or agent auth — all are supported).

```bash
cd plugin
npm install
npm run build:full        # builds the linux/amd64 daemon and copies
                          # main.js / manifest.json / styles.css /
                          # server-bin/ into the dev vault
```

`build:full` writes into the dev vault path baked into
`scripts/dev-install.mjs`. Open that vault in Obsidian, enable the
"Remote SSH" plugin under Settings → Community plugins, and reload.

## Quickstart

1. **Add an SSH profile.** Settings → Remote SSH → "+ Add". Fill in
   host, port, username, auth method (privateKey / password / agent),
   and the **remote vault path** (relative paths are home-relative —
   `work/VaultDev` resolves to `~/work/VaultDev` on the remote).
2. **Choose a transport.** `RPC` (recommended) auto-deploys the daemon
   and gives you live updates, range-served binaries, and faster fs
   ops. `SFTP` is the fallback and works without the daemon.
3. **Connect.** Either click the StatusBar icon or run "Remote SSH:
   Connect to remote vault" from the command palette. On success the
   notice reads `Connected to <name> as <user>@<host> via RPC`. With
   `autoPatchAdapter` on (the default), the file explorer immediately
   reflects the remote vault — no extra command needed.
4. **Edit.** Reads/writes go through the patched adapter. Saves land
   on the remote atomically (tmp + rename).
5. **Disconnect.** StatusBar click or "Remote SSH: Disconnect from
   remote vault". Adapter is restored cleanly.

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `Client ID` | OS hostname (sanitized) | Per-device subtree on the remote: `.obsidian/user/<clientId>/`. Holds workspace.json, cache, graph state — anything that shouldn't be shared between machines. |
| `User name` | OS username | Cosmetic — surfaces in the connect notice as `<user>@<host>`. |
| `Auto-patch adapter on connect` | `true` | When on, connect immediately routes reads/writes through the remote (the VSCode "open folder on host" equivalent). Off only for plugin development. |
| `Reconnect attempts after unexpected disconnect` | `5` | Exponential backoff up to 30 s between attempts. `0` disables auto-reconnect entirely (drops to ERROR). |
| `Debug logging` | `false` | Enables verbose `logger.debug` lines in the in-memory log + sink. |

## Per-client subtree (PathMapper)

Files that hold UI state are redirected to a per-client subtree so two
machines can edit the same vault without overwriting each other's tab
layout. Default redirected paths:

- `.obsidian/workspace.json`
- `.obsidian/workspace-mobile.json`
- `.obsidian/cache` (and the whole `cache/` subtree)
- `.obsidian/cache.zlib`
- `.obsidian/types.json`
- `.obsidian/file-recovery.json`
- `.obsidian/graph.json`
- `.obsidian/canvas.json`

Everything else under `.obsidian/` (hotkeys, plugins, themes,
snippets, community-plugins.json) is shared across clients. When you
change `Client ID`, the previous subtree stays on the remote with no
automatic migration; copy files manually if you want them.

## Reconnect behaviour

If the SSH session drops unexpectedly, the plugin enters a retry loop
(`Reconnecting (1/5) in 1s…` → `(attempt 1/5)…` → `Reconnected`). The
patched adapter stays attached the whole time:

- **Reads** are served from the in-memory cache on hit; cache miss
  throws a stable "Remote SSH: reconnecting" error.
- **Writes / list / stat** throw immediately (no silent buffering).
- **fs.changed** subscriptions are restored after reconnect — no
  manual refresh.

You can cancel the loop early with the "Remote SSH: Cancel ongoing
reconnect" command (only visible while the loop is active).

## Known limitations

- **Plugins that bypass `app.vault.adapter`** won't see the remote
  vault. Anything calling Node `fs` directly, reading
  `app.vault.adapter.basePath` and joining paths, or using Obsidian
  internal APIs we don't intercept, will read or write the local
  filesystem instead. See [docs/plugin-compatibility.md](docs/plugin-compatibility.md)
  for the rolling list.
- **Mobile (iOS / Android)** is unsupported. The plugin requires Node
  APIs that only exist on desktop Obsidian.
- **First read of a large file** still pulls the full contents over
  the wire. Range-aware seeks (PDF / mp4 scrubbing) are free after
  that as long as the file fits in the read cache (default 64 MB).
  Bigger files re-fetch on cache eviction. True partial reads
  (`fs.readBinaryRange`) are planned.
- **Symlinks** on the remote are followed by stat / read. We don't
  expose them as symlinks to Obsidian.
- **One profile at a time.** Multi-vault concurrent sessions aren't
  supported; disconnect, then connect to a different profile.
- **Daemon binary is linux/amd64 only** in the current build. Other
  remote architectures need a cross-compile in `scripts/build-server.mjs`.

## Troubleshooting

- **"daemon binary not staged"**: run `npm run build:full` (or
  `build:server`) and reload the plugin. Linux/amd64 only for now.
- **"adapter patch failed"**: connect again with the autoPatchAdapter
  setting off, then run `Debug: patch adapter` and watch
  `<vault>/.obsidian/plugins/remote-ssh/console.log` for the actual
  error.
- **The file explorer is empty after connect**: open the console.log.
  If you see `PathMapper: clientId="..."` followed by errors, the
  patch ran but the listing failed. If you don't see the PathMapper
  line, the patch never ran — check `autoPatchAdapter` is on.
- **Reconnect spins forever then fails**: `Reconnect attempts` is set
  too high or the remote is genuinely down. Set it to a smaller value
  or `0` to fail-fast.
- **Images / PDFs don't render**: the ResourceBridge needs `RPC`
  transport. Check the active profile's transport setting.

The console log lives at
`<vault>/.obsidian/plugins/remote-ssh/console.log` (rolling, ~5 MB
cap, 3 generations). It's the first thing to check before filing
anything.

## Working in the repo

| Task                       | Where |
|----------------------------|-------|
| Build / test the plugin    | `cd plugin && npm test` / `npm run build:full` |
| Build / test the server    | `cd server && go test ./... && make test` |
| Edit shared protocol types | `proto/types.go` + `plugin/src/proto/types.ts` (move both in the same PR) |

CI runs each side independently so plugin changes don't block server
work and vice versa.

## Acknowledgements

Inspired by VSCode's Remote-SSH model. The wire format is an
LSP-style framed JSON-RPC over a unix-socket-forwarded stream — the
same shape language servers use, just for filesystem ops.
