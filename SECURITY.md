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

## Acknowledgements

We appreciate every responsible disclosure. Reporters are credited
in the security advisory once the issue is publicly disclosed,
unless they prefer to remain anonymous.
