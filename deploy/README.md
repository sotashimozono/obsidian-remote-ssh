# Deploying obsidian-remote-ssh on the server side

Three turn-key options for getting an SSH endpoint that the plugin
can connect to. **Pick the one that matches your existing setup.**

| Option | When to use | Status |
|---|---|---|
| [`docker/`](./docker/) — docker-compose + Dockerfile | You have docker on the server (or a VPS that supports it). Fastest path from zero. | ✅ available (E4-a.A) |
| `systemd/` — daemon as a managed service | You already have an OpenSSH server you want to keep using, and you want the obsidian-remote-server daemon to run as a persistent unit (rather than auto-deployed per-connect). | 🚧 planned (E4-a.B) |
| `install.sh` — one-line installer | You want `curl … \| bash` simplicity on a fresh box. | 🚧 planned (E4-a.C) |

In every model, the plugin's profile points at the SSH endpoint
(host / port / user / private key) and the rest of the wiring
happens automatically.

## Existing infrastructure

If you already have an SSH server you log into for other things, you
**don't need any of this**. Just install the plugin, point a profile
at the server, and connect. The plugin auto-deploys its
`obsidian-remote-server` daemon binary into your home dir
(`~/.obsidian-remote/`) on first connect — no Go toolchain or root
access required on the server.

The deploys here exist for users who want either:
- a turn-key SSH endpoint without manually configuring openssh-server
  / users / keys (= the docker option), or
- a managed daemon that survives plugin reconnects + supports
  multiple concurrent devices (= the planned systemd option).
