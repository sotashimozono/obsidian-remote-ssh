# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

This project handles SSH credentials and ships an auto-deployed
remote daemon — the attack surface is non-trivial. Responsible
disclosure helps us patch + release before the issue is public.

To report a vulnerability:

1. Open a **private GitHub Security Advisory** at
   <https://github.com/sotashimozono/obsidian-remote-ssh/security/advisories/new>.
2. Include: a minimal reproduction, the affected version, your
   suggested severity (low / medium / high / critical), and any
   suggested fix or mitigation.

## Response timeline

- **Acknowledgement**: within 7 days.
- **Triage + initial assessment**: within 14 days of acknowledgement.
- **Fix availability** (in main + the next release): depends on
  severity and complexity. Critical issues we aim for ≤ 14 days
  after triage; lower-severity issues land on the normal release
  cadence.
- **Public disclosure**: coordinated with the reporter, typically
  after a fixed release ships.

## What's in scope

- The Obsidian plugin code (`plugin/src/**`).
- The Go daemon (`server/**`) running on the user's remote SSH host.
- The shared protocol (`plugin/src/proto/types.ts` ↔
  `server/internal/proto/types.go`).
- Release artefacts (signed daemon binaries, plugin bundle).
- CI workflows, especially anything touching `secrets.*`.

## What's out of scope

- Vulnerabilities in upstream dependencies (`ssh2`, `fsnotify`,
  Obsidian itself, etc.) — please report those upstream and CC us
  if our usage is implicated.
- Configuration mistakes by the operator (e.g. running the daemon
  as root, exposing the SSH host on a public IP without auth) —
  unless the plugin actively encourages or facilitates the misuse.
- Social-engineering scenarios where the user explicitly accepts a
  prompt that surfaces the risk (e.g. trusting a host-key change
  in the upcoming `HostKeyMismatchModal` — we surface the diff and
  the security implication; the user's choice to trust is theirs).

## Verifying release artefacts

Daemon binaries shipped via GitHub Releases are signed with
[Sigstore cosign](https://www.sigstore.dev/) keyless OIDC against
this repository's GitHub Actions identity. Verify any release
binary independently with:

```bash
cosign verify-blob \
  --bundle obsidian-remote-server-linux-amd64.bundle \
  --certificate-identity-regexp 'https://github.com/sotashimozono/obsidian-remote-ssh/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  obsidian-remote-server-linux-amd64
```

The plugin's `ServerDeployer` performs a sha256 round-trip
verification on every deploy (`plugin/src/transport/ServerDeployer.ts`
`verifyRemoteSha256`). A mismatch refuses to start the daemon.

## Threat model + defences

This plugin handles SSH credentials, deploys an auto-updating
binary on the user's remote host, and proxies vault file I/O over
that channel. The attack surface is non-trivial. This section
documents what we worry about and what's in place.

### Threats we explicitly defend against

#### 1. Network attacker between user and remote host

- **SSH itself.** All transport rides on the user's existing SSH
  session, not a custom protocol. No part of the plugin opens a
  cleartext socket.
- **Host-key TOFU.** First connection to a host stores the key
  fingerprint in `HostKeyStore` (per-host, persisted to
  `data.json`). Subsequent connections verify against the stored
  key. On mismatch, `HostKeyMismatchModal` (#132) surfaces both
  fingerprints side-by-side and asks the user to trust the new key
  (re-pin and proceed) or abort (refuse the handshake; the connect
  rejects with a `host-key` taxonomy error). The pinned key is
  preserved on abort so a single rogue prompt cannot displace a
  trusted fingerprint.
- **No fallback to insecure auth.** `AuthResolver` honours the
  user's `~/.ssh/config` `IdentityFile` directives and falls back
  to ssh-agent. Password auth is opt-in per profile, never the
  default.

#### 2. Compromised / malicious daemon binary

- **Pinned cosign signatures.** Every release ships
  `obsidian-remote-server-<os>-<arch>` plus a
  `obsidian-remote-server-<os>-<arch>.bundle` Sigstore (cosign)
  keyless OIDC signature. The bundle is verifiable independently
  via the cosign CLI (see "Verifying release artefacts" above).
- **Pinned identity.** Signature certificates assert the GitHub
  Actions identity
  `https://github.com/sotashimozono/obsidian-remote-ssh/.github/workflows/release.yml@*`.
  Anyone can verify the binary was produced by THIS repo's CI,
  not a side-channel build.
- **sha256 round-trip on every deploy.** `ServerDeployer.verifyRemoteSha256`
  computes sha256 of the local binary, compares against
  `sha256sum` on the remote after upload. Mismatch refuses to
  start the daemon. Catches both transport corruption and a
  malicious host swapping the binary between SFTP-upload and
  `nohup` start.
- **`daemon-manifest.json`** in each release lists every binary's
  expected sha256 — a separate signed artefact for at-a-glance
  pinning of "what should this version's binaries be."

#### 3. Credential exfiltration

- **OS keychain by default.** `SecretStore` (`plugin/src/ssh/SecretStore.ts`)
  uses `keytar`-style platform keychains where available
  (Windows Credential Manager, macOS Keychain, libsecret).
- **Encrypted-at-rest fallback.** When the OS keychain isn't
  available, secrets are AES-GCM encrypted with a per-vault key
  derived from the vault's stable identifier. The encrypted blob
  lands in `data.json`; the key never does.
- **Secrets never reach the JSONL log.** The logger
  (`plugin/src/util/logger.ts`) runs every emit through a
  redactor that strips known credential field names + anything
  matching common token shapes.
- **Secrets never reach the wire as plaintext params.** RPC calls
  carry only the auth token written by the daemon to its own
  token file (read off the remote, never sent across by us).

#### 4. Malicious remote (compromised SSH host)

- **No code execution on the user's machine.** The daemon is
  deployed *to* the remote, not pulled *from* it. The remote can
  send malformed responses but cannot inject arbitrary code into
  the plugin process.
- **Vault-relative path validation.** Every fs RPC validates the
  requested path is within the user-configured vault root
  (`vaultfs.Resolve` on the daemon side). Path-traversal attempts
  return `PathOutsideVault`.
- **No symlink follow on writes.** The daemon's atomic writes
  (`atomicWriteFile`) go to a tmp file then rename — a malicious
  symlink swap can corrupt the tmp file but cannot redirect the
  write to a path the operator didn't grant access to.

#### 5. Multi-tenant remote host

- **Per-user `.obsidian-remote/` directory.** Daemon binary,
  socket, token, and log all live under `$HOME/.obsidian-remote/`
  by default — same UID isolation the OS already provides for
  every other home-directory file.
- **No `/tmp/` or world-writable paths.** Avoids the cross-user
  collision class of bugs.

### Threats we surface but do NOT prevent

These are operator decisions, not code defects:

- **Running the daemon as root.** The daemon doesn't elevate; if
  the user logs in as root, that's their authority to grant.
  Documented in README.
- **Exposing the SSH host on a public IP without auth hardening.**
  We don't operate the host; we connect to whatever the user
  configured.
- **Trusting a host-key change.** `HostKeyMismatchModal` (#132)
  shows the diff and the security implication; the user's choice
  to trust is theirs. We surface the prompt; we do not decide for
  them.

### What's stored, where

| Artifact | Location | Notes |
| --- | --- | --- |
| Plugin code (this repo) | `<vault>/.obsidian/plugins/remote-ssh/` | Standard Obsidian plugin layout |
| JSONL log | `<vault>/.obsidian/plugins/remote-ssh/console.log` | Redacted; rotated at 5 MB × 3 generations |
| `data.json` | same dir | Settings, host-key store, secret blob (encrypted), profile list |
| Daemon binary on remote | `$HOME/.obsidian-remote/server` | Re-deployed on every connect (sha256 verified); `.obsidian-remote/server.sock` is the unix socket; `.obsidian-remote/token` the per-session auth token |
| User vault files on remote | wherever the user pointed `remotePath` | Daemon does NOT write outside this root |

### Network surface

- **SSH/SFTP to the user's configured host(s).** Multi-hop via
  `ProxyJump` if the profile uses a `JumpHost`.
- **HTTPS to `raw.githubusercontent.com`** for fetching the
  Obsidian community-plugins.json and per-plugin manifests when
  the user opts into the Pending Plugins install flow. Goes
  through Obsidian's own `requestUrl` (CORS-friendly, no custom
  fetch).
- **HTTPS to GitHub releases** when the user manually downloads
  a daemon binary. Plugin itself never auto-fetches a binary
  from the network — what it deploys to the remote is the
  binary that came bundled in the plugin's installed `server-bin/`
  directory.
- **Local-loopback HTTP server** (`ResourceBridge`,
  `127.0.0.1:<random-port>`) serves binary content (images,
  PDFs) to the Obsidian webview. Requests gated by a per-session
  bearer token; the port and token rotate every session.

### Internal Obsidian API usage

We use a small set of unsupported `app.plugins.*` methods
(`installPlugin`, `enablePluginAndSave`) for the shadow-vault
"install community plugins from source vault" flow
(see `plugin/src/shadow/PluginMarketplaceInstaller.ts`). These
methods power Obsidian's own community plugin browser and have
been stable across recent releases. We don't pierce any other
internal surface.

## Acknowledgements

We appreciate every responsible disclosure. Reporters are credited
in the security advisory once the issue is publicly disclosed,
unless they prefer to remain anonymous.
