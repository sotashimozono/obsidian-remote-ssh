---
title: Profiles
tags: [configuration, reference]
description: "Full configuration reference for obsidian-remote-ssh profiles: host, port, username, auth method, vault path, jump host, transport mode, SSH session tuning."
---

# Configuration reference — Profiles

Each SSH profile is one connection target. Every field is configured per-profile under **Settings** → **Profiles** → click a profile.

## Identification

| Field | Type | Default | Description |
|---|---|---|---|
| Profile name | string | `New Profile` | Display label only |
| Host | string | (required) | Hostname or IP — anything `ssh` accepts |
| Port | number | `22` | TCP port |
| Username | string | (required) | Remote SSH user |

## Authentication

| Field | Type | Default | Description |
|---|---|---|---|
| Authentication | enum | `privateKey` | One of `privateKey`, `password`, `agent` |
| Private key path | string | — | Path to private key file; `~` expanded at runtime |

See [[en/user-guide/ssh-config|SSH config & keys]] for what each method means.

## Remote vault

| Field | Type | Default | Description |
|---|---|---|---|
| Remote vault path | string | (required) | Absolute or `~`-relative path; e.g. `/home/pi/notes`, `~/work/vault`. Must exist; the plugin will not auto-create it. |

## Transport

| Field | Type | Default | Description |
|---|---|---|---|
| Mode | enum | `sftp` | `sftp` (direct SFTP — current default) or `rpc` (auto-deploys daemon, lower latency) |
| Daemon socket path | string | `.obsidian-remote/server.sock` (home-relative) | Unix socket the daemon listens on (`rpc` mode) |
| Daemon token path | string | `.obsidian-remote/token` (home-relative) | Auth token file location (`rpc` mode) |

The remote daemon binary path is fixed at `~/.obsidian-remote/server` (not user-configurable in the current UI).

`rpc` mode is faster (~10x lower per-op latency than SFTP) and supports server-push notifications via [[en/api/watch|fs.watch]]. `sftp` is the safer fallback when you cannot deploy a binary on the remote.

## Jump hosts

Click **Add jump host** under a profile. Each entry has its own Host / Port / Username / Auth. Hops chain in order. See [[en/user-guide/jump-host|Jump hosts]] for the model.

## Where settings live

```
<vault>/.obsidian/plugins/remote-ssh/data.json
```

**Passwords are never persisted**. Private key paths are stored; the keys themselves are NOT copied into the plugin (read fresh each connect).

If you sync your `.obsidian` directory across machines, your profile list syncs too — be aware that `Private key path` is a path that may not exist on every device.

For the on-disk schema (every field, every default, hand-editing rules), see [[en/reference/data-json|data.json schema reference]].

Next: [[en/configuration/this-device|This device]].

## Allowed hidden directories

Remote SSH hides dot-prefixed folders by default. To browse documents under
one of these folders, edit the SSH profile and add its exact vault-relative
path to **Allowed hidden directories**, one per line. For example, with
`/home/user` as the remote vault path, add `.herdr` to browse
`/home/user/.herdr/worktrees` without a symlink or a separate vault.

Each hidden ancestor needs an entry: `.herdr` does not also allow
`.herdr/.private`; add both paths if you want both. Entries are directory
paths, not patterns or absolute paths. Dotfiles stay hidden. **Ignore
directories** takes precedence, and vault configuration stays excluded.
Reopen the remote vault after saving the profile to rebuild its file tree.
