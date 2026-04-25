# proto

Shared JSON-RPC protocol between the obsidian-remote-ssh plugin
(TypeScript) and the obsidian-remote-server daemon (Go).

## Transport

- **Length-prefixed JSON messages** (LSP-style framing) over a unix
  socket. One message per frame; no WebSocket or HTTP on this channel.
    ```
    Content-Length: <bytes>\r\n
    \r\n
    <JSON body>
    ```
- The plugin opens a local TCP connection that SSH forwards to the
  daemon's unix socket (`ssh -L <port>:<sockpath> …`). Nothing is
  exposed to the network.
- The framing handles multi-MB payloads cleanly and lets both sides
  reject oversized messages up front (future limit, configurable).
- Binary payloads (file bytes) are base64-encoded inside the JSON
  body. MVP trade-off: +33% wire overhead for a much simpler client.
  Attachment serving for `getResourcePath` lives on a separate HTTP
  channel on a second forwarded port (Phase 5-F); this channel is
  always framed JSON.

## Handshake

Before any `fs.*` method succeeds, the client must authenticate:

```
→ { "jsonrpc": "2.0", "id": 1, "method": "auth", "params": { "token": "…" } }
← { "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }
```

- The server writes `~/.obsidian-remote/token` (mode `0600`) at startup
  with a fresh 32-byte random token.
- The plugin reads that file over SSH (since SSH already authenticates
  the right user, and POSIX perms forbid other local users from
  reading it) and presents it here.
- A session is pinned to one authenticated client. Rejecting `auth`
  closes the connection.

After `auth` succeeds, the plugin should call `server.info` once to
check protocol compatibility.

## Versioning

The protocol version is an integer. The client is responsible for
refusing to proceed when the server advertises a version it does not
understand. Breaking changes bump the integer; additive changes do
not.

Current protocol version: **1**.

## Path conventions

All paths are **vault-relative** and use **forward slashes**.

- `"note.md"`, `"docs/sub/a.md"` — valid
- `""` or `"/"` — the vault root itself
- `"../"` or any `..` component — rejected with `PathOutsideVault`
- A leading `/` (absolute path) — rejected with `PathOutsideVault`

The vault root is fixed at server start via `--vault-root=<abs>`. The
server refuses to open any path that, once resolved, does not live
under that root.

## Methods

| Method              | Params                                        | Result                              |
|---------------------|-----------------------------------------------|-------------------------------------|
| `auth`              | `{ token }`                                    | `{ ok: true }`                      |
| `server.info`       | `{}`                                           | `ServerInfo`                        |
| `fs.stat`           | `{ path }`                                     | `Stat \| null`                      |
| `fs.exists`         | `{ path }`                                     | `{ exists: boolean }`               |
| `fs.list`           | `{ path }`                                     | `{ entries: Entry[] }`              |
| `fs.readText`       | `{ path, encoding? }`                          | `ReadTextResult`                    |
| `fs.readBinary`     | `{ path }`                                     | `ReadBinaryResult`                  |
| `fs.write`          | `{ path, content, expectedMtime? }`            | `{ mtime }`                         |
| `fs.writeBinary`    | `{ path, contentBase64, expectedMtime? }`      | `{ mtime }`                         |
| `fs.append`         | `{ path, content }`                            | `{ mtime }`                         |
| `fs.appendBinary`   | `{ path, contentBase64 }`                      | `{ mtime }`                         |
| `fs.mkdir`          | `{ path, recursive? }`                         | `{}`                                |
| `fs.remove`         | `{ path }`                                     | `{}`                                |
| `fs.rmdir`          | `{ path, recursive? }`                         | `{}`                                |
| `fs.rename`         | `{ oldPath, newPath }`                         | `{ mtime }`                         |
| `fs.copy`           | `{ srcPath, destPath }`                        | `{ mtime }`                         |
| `fs.trashLocal`     | `{ path }`                                     | `{}`                                |
| `fs.watch`          | `{ path, recursive? }`                         | `{ subscriptionId }`                |
| `fs.unwatch`        | `{ subscriptionId }`                           | `{}`                                |

Shapes:

```ts
interface ServerInfo {
  version: string;         // implementation version, e.g. "0.1.0"
  protocolVersion: number; // currently 1
  capabilities: string[];  // e.g. ["fs.stat", "fs.watch", …]
  vaultRoot: string;       // absolute path on the remote host (informational)
}

interface Stat {
  type: 'file' | 'folder';
  mtime: number;  // unix milliseconds
  size: number;   // bytes (0 for folders)
  mode: number;   // POSIX mode bits (informational)
}

interface Entry {
  name: string;   // basename only, no slashes
  type: 'file' | 'folder' | 'symlink';
  mtime: number;
  size: number;
}

interface ReadTextResult  { content: string;        mtime: number; size: number; encoding: 'utf8'; }
interface ReadBinaryResult { contentBase64: string; mtime: number; size: number; }
```

Atomicity notes:
- `fs.write` and `fs.writeBinary` are atomic on the remote (tmp file
  + rename). If `expectedMtime` is set and the current file's mtime
  does not match, the server rejects with `PreconditionFailed`.
- `fs.rename` creates the destination's parent directory if needed.
- `fs.copy` goes through the file contents (no server-side reflink).
- `fs.trashLocal` moves the path under `<vaultRoot>/.trash/…`,
  creating intermediate dirs as needed.

## Notifications (server → client)

The server pushes notifications on subscribed paths:

```
{
  "jsonrpc": "2.0",
  "method": "fs.changed",
  "params": {
    "subscriptionId": "…",
    "path": "note.md",
    "event": "created" | "modified" | "deleted" | "renamed",
    "mtime"?: number,
    "newPath"?: string   // set when event === "renamed"
  }
}
```

- Events are debounced on the server (coalesced if the same path is
  touched within a few hundred ms) so a single editor save doesn't
  flood the wire.
- An `fs.watch` subscription with `recursive: true` emits events for
  every descendant.

## Error codes

| Code     | Name                   | When                                                        |
|----------|------------------------|-------------------------------------------------------------|
| `-32700` | ParseError             | Not JSON.                                                   |
| `-32600` | InvalidRequest         | JSON-RPC envelope is malformed.                             |
| `-32601` | MethodNotFound         | Unknown method.                                             |
| `-32602` | InvalidParams          | Params don't match the method's shape.                      |
| `-32603` | InternalError          | Unexpected server error.                                    |
| `-32000` | AuthRequired           | A non-`auth` method was called before auth succeeded.       |
| `-32001` | AuthInvalid            | `auth` called with a wrong token.                           |
| `-32010` | FileNotFound           | Path doesn't exist on the remote.                           |
| `-32011` | NotADirectory          | `fs.list` / `fs.rmdir` target is a file.                    |
| `-32012` | IsADirectory           | A file-only op targeted a directory.                        |
| `-32013` | Exists                 | Create-like op found the path already present.              |
| `-32014` | PermissionDenied       | OS rejected the operation (mode bits, quota, …).            |
| `-32015` | PathOutsideVault       | Resolved path escapes the vault root.                       |
| `-32020` | PreconditionFailed     | `expectedMtime` did not match the file's current mtime.     |
| `-32021` | ProtocolVersionTooOld  | `server.info` returned a version the client can't speak.    |

## Source of truth

- This document is normative for wire shape.
- `plugin/src/proto/types.ts` and `server/internal/proto/types.go`
  are hand-maintained mirrors. When the spec changes, both sides
  move in the same PR.
