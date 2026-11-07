---
title: Daemon CLI reference
tags: [reference, daemon, cli]
description: "obsidian-remote-ssh-server CLI reference: --vault-root / --socket / --token-file / --verbose / --version flags, exit codes, signal handling, state directory layout."
---

# Daemon CLI reference

Complete reference for the `obsidian-remote-server` binary. The plugin invokes this for you on every connect (see [[en/server/auto-deploy|Plugin auto-deploy]]); this page is for operators running it manually under systemd, in containers, or for debugging.

## Synopsis

```
obsidian-remote-server --vault-root=<path> [--socket=<path>] [--token-file=<path>] [--verbose]
obsidian-remote-server --version
```

## Flags

### Required

#### `--vault-root <path>`

Absolute path of the vault directory on this host. The daemon refuses to start if:

- The flag is missing or empty
- The path does not exist
- The path is not a directory

The daemon will reject any RPC operation whose resolved path escapes this root (`PathOutsideVault` error, code `-32015`).

```bash
obsidian-remote-server --vault-root=/home/me/notes
```

Relative paths are accepted but resolved to absolute via `filepath.Abs` at startup. Symlinks in the vault root path are followed.

### Optional

#### `--socket <path>`

Unix socket the daemon listens on. **Default: `<state-dir>/server.sock`** (state-dir is normally `~/.obsidian-remote/`).

The daemon:
1. Creates the parent directory with mode `0700` if missing
2. Takes an exclusive lock on `<socket>.lock` and `<token-file>.lock`, waiting up to 2 s for a daemon that is shutting down. If another daemon on this host still holds either, exits with code `1` and leaves that daemon's socket and token file alone. Otherwise removes any existing file at the socket path (cleanup of a dangling socket from a crashed prior run)

   The lock is skipped, with a warning in the log, when it cannot protect the path: on a filesystem without working `flock`, or when the holder is a daemon on another host (a home directory shared over NFS, where the lock reaches every host but a Unix socket does not). The daemon then behaves as it did before the lock existed.
3. Binds the Unix socket
4. Chmods the socket to `0600` so only the daemon's user can connect

```bash
obsidian-remote-server --vault-root=/srv/vault --socket=/srv/vault-state/server.sock
```

#### `--token-file <path>`

Path the daemon writes its session token to at startup. **Default: `<state-dir>/token`**.

The token is 32 random bytes (hex-encoded → 64 chars), generated via `crypto/rand`. The file is written with mode `0600` and removed when the daemon exits cleanly. Plugins read this file via SFTP and present it on the `auth` RPC.

#### `--verbose`

Enable debug-level logging to **stderr** (slog text format). Without this, logging is discarded entirely (`io.Discard`).

The plugin's auto-deploy passes `--verbose` so the daemon's stderr ends up in `~/.obsidian-remote/server.log` (the spawn redirects stderr → that log file). For systemd-managed setups, decide based on whether you want noise in journalctl.

#### `--version`

Print the daemon version (one line) and exit `0`. Used by plugin-side diagnostics + script health checks. Bypasses all other flags.

```bash
obsidian-remote-server --version
# → 0.1.0
```

## State directory layout

When `--socket` and `--token-file` are not given, both default into `<state-dir>`. State-dir resolves to:

| OS | Path |
|---|---|
| Linux / macOS / BSD | `$HOME/.obsidian-remote/` |
| Windows | (daemon doesn't run on native Windows; see [[en/server/overview\|Server overview]]) |

So a typical invocation with all defaults plants:

```
~/.obsidian-remote/
    server.sock      # the Unix socket the daemon listens on (mode 0600)
    server.sock.lock # held by the running daemon; decides which daemon owns the socket. Left in place on exit
    token            # 32-byte hex token (mode 0600); auto-removed on clean exit
    token.lock       # the same, for the token
```

You can override either path independently — useful for multi-vault setups (one socket per vault on the same OS user; see [[en/server/multi-user|Multi-user hosting]]).

## Invocation patterns

### Manual smoke test

```bash
~/.obsidian-remote/server \
  --vault-root=$HOME/notes \
  --verbose \
  > ~/.obsidian-remote/server.log 2>&1 &
disown
```

After this, the plugin's reuse probe will attach without redeploying. To stop:

```bash
pkill -f obsidian-remote-server
```

### Same as the plugin's auto-deploy

```bash
nohup ~/.obsidian-remote/server \
  --vault-root=/home/pi/notes \
  --socket=/home/pi/.obsidian-remote/server.sock \
  --token-file=/home/pi/.obsidian-remote/token \
  --verbose \
  > /home/pi/.obsidian-remote/server.log 2>&1 < /dev/null &
```

Reverse-engineered from `ServerDeployer`. The plugin uses `nohup … < /dev/null &` so the daemon survives the SSH session that spawned it.

### Under systemd (per-user)

See the full unit at [[en/cookbook/systemd-managed-daemon|systemd-managed daemon]]. Key fragment:

```ini
ExecStart=/usr/local/bin/obsidian-remote-server \
  --vault-root=%h/notes \
  --socket=%h/.obsidian-remote/server.sock \
  --token-file=%h/.obsidian-remote/token \
  --verbose
```

`%h` expands to the user's home; lets one unit file work for any user via `systemctl --user`.

### Multi-vault on the same user

Different daemons need different sockets:

```bash
# Daemon for the work vault
~/.obsidian-remote/server \
  --vault-root=$HOME/work-notes \
  --socket=$HOME/.obsidian-remote/work.sock \
  --token-file=$HOME/.obsidian-remote/work.token &

# Daemon for the personal vault
~/.obsidian-remote/server \
  --vault-root=$HOME/personal-notes \
  --socket=$HOME/.obsidian-remote/personal.sock \
  --token-file=$HOME/.obsidian-remote/personal.token &
```

In the plugin profile for each, set the matching socket + token paths. See [[en/cookbook/multi-vault|multi-vault recipe]].

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown (SIGINT / SIGTERM received and listener drained, or `--version` printed) |
| `1` | Runtime error after startup (another daemon already serves the socket, cannot bind socket, token write failed, vault root vanished, etc.) — message goes to stderr |
| `2` | Argument parse error (missing required flag, invalid value) — flag.ContinueOnError surfaces this |

## Signal handling

The daemon installs a SIGINT + SIGTERM handler that closes the listener, removes the socket file + token file, releases the locks, and then waits for open connections to finish before it exits `0`. This is graceful shutdown.

The files go and the locks are released *before* the drain, while the daemon still owns the paths. A redeploy starts the new daemon right after sending SIGTERM, so the new daemon can take the locks at once. The old daemon never touches the paths again after that, even if it takes a while to drain.

The handler only catches the first signal. A second SIGINT or SIGTERM kills a daemon that is still draining, so a connection that never closes cannot keep it alive past the next `pkill`.

`kill -9` (SIGKILL) skips the cleanup. The kernel still drops the lock when the process dies, so the next daemon takes it, finds the stale socket file at `<socket>` and removes it before binding fresh. A hard kill doesn't permanently jam the path.

## Environment variables

The daemon does **not** read any environment variables for configuration — all config goes through CLI flags. Things that DO affect the daemon implicitly:

| Env var | Effect |
|---|---|
| `HOME` | Determines the default state-dir (`$HOME/.obsidian-remote/`) when `--socket` / `--token-file` are not given |
| `TZ` | Affects `slog`'s timestamp output when `--verbose` is on; otherwise irrelevant |

The plugin's environment (Obsidian's `process.env`) is irrelevant to the daemon — they're separate processes on different hosts.

## What the daemon does NOT do

- **It does not detach from its terminal on its own.** Use `nohup … &` or run under systemd to background it. (Plugins do this for you.)
- **It does not rotate its own log file.** When run via the plugin, stdout+stderr are piped to `~/.obsidian-remote/server.log` and that file truncates only on daemon restart. Under systemd, journalctl handles retention.
- **It does not bind a TCP port.** Unix socket only — see [[en/server/firewall|Firewall, ports & NAT]].
- **It does not retry-on-fail.** Process-level supervision (systemd `Restart=on-failure`, the plugin's reuse-probe-then-redeploy fallback) handles that.

## See also

- [[en/server/auto-deploy|Plugin auto-deploy]] — what the plugin does to invoke the daemon
- [[en/server/systemd|systemd unit]] — production unit-file template
- [[en/architecture/release-pipeline|Release & deploy pipeline]] — how the binary is built + signed
- [[en/api/overview|API overview]] — the JSON-RPC the daemon speaks once it's up
