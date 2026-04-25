# obsidian-remote-ssh

A VS Code Remote-SSH–style remote vault experience for Obsidian, built
around a small Go daemon that runs on the remote host and serves the
plugin over an SSH-tunnelled WebSocket.

## Repository layout

```
plugin/   Obsidian plugin (TypeScript, esbuild)
server/   obsidian-remote-server daemon (Go)
proto/    Shared JSON-RPC protocol definitions
```

The plugin uploads the server binary over SSH on first connect, starts
it as a background process bound to a unix socket, and forwards a local
port to that socket so the rest of the session can speak JSON-RPC over
a single WebSocket connection.

## Working in the repo

| Task                       | Where                  |
|----------------------------|------------------------|
| Build / test the plugin    | `cd plugin && npm ...` |
| Build / test the server    | `cd server && make ...` |
| Edit shared protocol types | `proto/` (TS + Go in lockstep) |

The plugin retains its previous npm scripts; the only change is that
they now run from `plugin/` instead of the repo root. CI runs each
side independently so plugin changes don't block server work and vice
versa.

## Status

This README describes the target architecture. The concrete protocol,
server methods, and the auto-deploy flow land in subsequent phases —
the monorepo layout is in place first so each piece has a home.
