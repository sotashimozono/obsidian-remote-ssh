# Testing strategy

This document records the test architecture for `obsidian-remote-ssh`,
adopted in v0.4.19 (Phase A) and v0.4.22 (Phase B). It complements
[architecture-shadow-vault.md](./architecture-shadow-vault.md) — the
shadow-vault flow is what we test; this doc explains *how*.

## Goals

- **G1** — Two clients editing the same remote vault don't break each
  other: shared content converges, per-client UI state stays isolated.
- **G2** — The plugin builds and unit-tests pass on every desktop OS
  Obsidian itself ships on (Linux / macOS / Windows).

## Layers

```mermaid
flowchart TB
    subgraph Local["Per-PR / per-push"]
        unit["Unit tests<br/>vitest, fully mocked<br/>~330 tests, ~2 s"]
        types["TypeScript noEmit<br/>+ ESLint"]
        bundle["Production build<br/>+ bundle-size guard (<600 KB)"]
    end
    subgraph Container["Per-PR (Linux only)"]
        sftp_int["SSH integration<br/>SftpClient vs Docker sshd"]
        mc_sftp["Multi-client SFTP convergence<br/>(Phase A1)"]
        mc_rpc["Multi-client RPC fs.watch<br/>(Phase A3)"]
    end
    subgraph Matrix["Per-PR (matrix)"]
        ubuntu["ubuntu-latest"]
        macos["macos-latest"]
        windows["windows-latest"]
    end
    Local --> Matrix
    Container --> ubuntu
```

`Local` runs on the matrix. `Container` runs only on `ubuntu-latest`
because Linux containers aren't available on macOS / Windows GitHub
runners.

## Phase A — Multi-client convergence

The shadow-vault model assumes a user can have several Obsidian
instances pointed at the same remote vault and they will not corrupt
each other. The integration tests in `plugin/tests/integration/`
exercise that assumption against a real `sshd` running in Docker.

### Sequence under test

```mermaid
sequenceDiagram
    participant A as Client A<br/>clientId=alpha
    participant S as Docker sshd<br/>(+ obsidian-remote-server in RPC tests)
    participant B as Client B<br/>clientId=beta

    Note over A,B: shared vault root: /home/tester/vault

    A->>S: write shared/note.md "from A"
    B->>S: list shared/
    S-->>B: [note.md]
    B->>S: read shared/note.md
    S-->>B: "from A"
    Note right of S: ✓ G1: shared convergence

    A->>S: write .obsidian/workspace.json "{layout:A}"
    Note right of S: PathMapper → .obsidian/user/alpha/workspace.json
    B->>S: write .obsidian/workspace.json "{layout:B}"
    Note right of S: PathMapper → .obsidian/user/beta/workspace.json
    A->>S: read .obsidian/workspace.json
    S-->>A: "{layout:A}"
    B->>S: read .obsidian/workspace.json
    S-->>B: "{layout:B}"
    Note right of S: ✓ G1: per-client isolation

    Note over A,S: RPC mode only
    A->>S: fs.watch shared/
    B->>S: write shared/live.md "x"
    S-->>A: fs.changed shared/live.md "created"
    Note right of S: ✓ G1: cross-client live notify
```

### Test files

| File | What it covers | Phase |
|---|---|---|
| `plugin/tests/integration/ssh.integration.test.ts` | `SftpClient` raw protocol round-trips. *Pre-A baseline.* | — |
| `plugin/tests/integration/multiclient.sftp.test.ts` | Two `SftpDataAdapter` instances over SFTP: shared write/read, PathMapper isolation, delete/rename convergence. | A1 |
| `plugin/tests/integration/multiclient.rpc.test.ts` | The same scenarios over the RPC transport, plus `fs.watch` cross-client notifications. | A3 |
| `plugin/tests/integration/helpers/makeAdapter.ts` | Factory that builds a fully-wired `SftpDataAdapter` for a given clientId. | A1 |
| `plugin/tests/integration/helpers/deployDaemonOnce.ts` | `describe`-scoped helper that builds + deploys the Go daemon to the test sshd container so RPC tests can talk to it. Runtime deploy via `ServerDeployer`, same code path as production. | A2 |

The pre-existing `npm run test:integration` script picks up everything
under `tests/integration/` automatically — no new vitest config is
required.

### Daemon deploy strategy

For RPC tests we **deploy the daemon at runtime via `ServerDeployer`**
rather than baking it into the docker image. Trade-offs:

- **Pro**: same code path as production, image rebuild isn't required
  when the daemon changes, the test catches deploy-time regressions.
- **Con**: each integration run spends ~1 s on the upload + chmod +
  start dance. Acceptable.

The Go binary is built once before the integration suite runs (CI step
`npm run build:server`) and lives at the path the production code
already knows about (`server-bin/obsidian-remote-server-linux-amd64`).

## Phase B — Multi-OS matrix

`ci.yml` runs `test` and `build` jobs on ubuntu / macos / windows.
`lint` and `server build/test` stay ubuntu-only (lint is OS-neutral by
construction; the server is a Linux binary).

```mermaid
flowchart LR
    push[push / PR] --> ci{ci.yml}
    ci --> lint_u[lint @ ubuntu]
    ci --> mat[matrix:<br/>ubuntu / macos / windows]
    mat --> unit[unit tests + coverage]
    mat --> build[build + bundle guard]
    ci --> server[server build/test @ ubuntu]

    push --> int{integration.yml}
    int --> u_int[Docker sshd<br/>+ multi-client tests<br/>**ubuntu only**]
```

### What we expect each runner to catch

| OS | Likely-caught classes of bug |
|---|---|
| ubuntu | Baseline. `node:fs` calls, ssh2 quirks, daemon deploy. |
| macos | Path case-sensitivity (HFS+ default-insensitive), `node:os.hostname()` differences. |
| windows | `path.sep === '\\'`, symlink fallback in `ShadowVaultBootstrap.installPlugin` (Developer mode off → expect copy, not symlink), CRLF/LF in test fixture files. |

### Out of scope for B

- Cross-OS multi-client integration (macOS client + Windows client
  editing the same remote). Defer until shadow-vault has real users
  asking for it; the cost is high (macOS runner billing) and the bug
  detection is largely subsumed by Phase A1+A3 + Phase B.
- Mobile (iOS / Android). The plugin is `isDesktopOnly: true`; mobile
  is a future scoping decision, not a CI gap.

## Authoring conventions

- Integration tests must be safe to run on a developer's laptop with a
  freshly-`npm run sshd:start`'d container; no test should require
  external state, and every test must clean its own files in
  `afterAll`.
- Each test file gets a unique subdir under `/home/tester/vault/`
  (`integration-${stamp}`) so parallel test files can run without
  trampling each other. Within a file, vitest is configured for
  serial execution (`fileParallelism: false`).
- Helper files live under `plugin/tests/integration/helpers/`;
  factories take a `clientId` argument so tests can describe two-party
  scenarios concisely.
