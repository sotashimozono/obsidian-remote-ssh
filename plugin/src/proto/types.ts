/**
 * Shared JSON-RPC protocol types between the obsidian-remote-ssh plugin and
 * the obsidian-remote-server daemon.
 *
 * **This file is a hand-maintained mirror of `server/internal/proto/types.go`.**
 * When the spec changes, both sides move in the same PR. See `proto/README.md`
 * for the normative protocol description.
 */

export const PROTOCOL_VERSION = 1;

// ─── core shapes ─────────────────────────────────────────────────────────────

export interface ServerInfo {
  /** Implementation version of the running daemon, e.g. "0.1.0". */
  version: string;
  /** Protocol version the daemon speaks. Must be compared against PROTOCOL_VERSION. */
  protocolVersion: number;
  /** Method names the daemon implements, e.g. ["fs.stat", "fs.list", ...]. */
  capabilities: string[];
  /** Absolute vault root on the remote host (informational; paths are vault-relative). */
  vaultRoot: string;
}

export interface Stat {
  type: 'file' | 'folder';
  /** Modification time in unix milliseconds. */
  mtime: number;
  /** Size in bytes. 0 for directories. */
  size: number;
  /** POSIX mode bits (informational). */
  mode: number;
}

export interface Entry {
  /** Basename only, no slashes. */
  name: string;
  type: 'file' | 'folder' | 'symlink';
  mtime: number;
  size: number;
}

// ─── method tables ───────────────────────────────────────────────────────────

export type MethodName =
  | 'auth'
  | 'server.info'
  | 'fs.stat'
  | 'fs.exists'
  | 'fs.list'
  | 'fs.walk'
  | 'fs.readText'
  | 'fs.readBinary'
  | 'fs.write'
  | 'fs.writeBinary'
  | 'fs.append'
  | 'fs.appendBinary'
  | 'fs.mkdir'
  | 'fs.remove'
  | 'fs.rmdir'
  | 'fs.rename'
  | 'fs.copy'
  | 'fs.trashLocal'
  | 'fs.watch'
  | 'fs.unwatch';

export interface MethodMap {
  'auth':            { params: AuthParams;            result: AuthResult };
  'server.info':     { params: Record<string, never>; result: ServerInfo };

  'fs.stat':         { params: PathOnlyParams;        result: Stat | null };
  'fs.exists':       { params: PathOnlyParams;        result: ExistsResult };
  'fs.list':         { params: PathOnlyParams;        result: ListResult };
  'fs.walk':         { params: WalkParams;            result: WalkResult };

  'fs.readText':     { params: ReadTextParams;        result: ReadTextResult };
  'fs.readBinary':   { params: PathOnlyParams;        result: ReadBinaryResult };

  'fs.write':        { params: WriteTextParams;       result: MtimeResult };
  'fs.writeBinary':  { params: WriteBinaryParams;     result: MtimeResult };
  'fs.append':       { params: AppendTextParams;      result: MtimeResult };
  'fs.appendBinary': { params: AppendBinaryParams;    result: MtimeResult };

  'fs.mkdir':        { params: MkdirParams;           result: Record<string, never> };
  'fs.remove':       { params: PathOnlyParams;        result: Record<string, never> };
  'fs.rmdir':        { params: RmdirParams;           result: Record<string, never> };
  'fs.rename':       { params: RenameParams;          result: MtimeResult };
  'fs.copy':         { params: CopyParams;            result: MtimeResult };
  'fs.trashLocal':   { params: PathOnlyParams;        result: Record<string, never> };

  'fs.watch':        { params: WatchParams;           result: WatchResult };
  'fs.unwatch':      { params: UnwatchParams;         result: Record<string, never> };
}

export type Params<M extends MethodName> = MethodMap[M]['params'];
export type Result<M extends MethodName> = MethodMap[M]['result'];

// ─── method param / result shapes ────────────────────────────────────────────

export interface AuthParams { token: string }
export interface AuthResult { ok: true }

export interface PathOnlyParams { path: string }
export interface ExistsResult { exists: boolean }
export interface ListResult { entries: Entry[] }

/**
 * fs.walk — single-RPC alternative to recursively calling fs.list.
 * `maxEntries` caps the response size; the daemon returns
 * `truncated: true` when the budget is exhausted so the caller can
 * fall back to per-folder listing without truncation lying about
 * tree shape.
 */
export interface WalkParams {
  path: string;
  recursive?: boolean;
  maxEntries?: number;
}
export interface WalkEntry {
  /** Vault-relative (forward slashes), unlike `Entry.name` which is a basename. */
  path: string;
  type: 'file' | 'folder' | 'symlink';
  mtime: number;
  size: number;
}
export interface WalkResult {
  entries: WalkEntry[];
  truncated: boolean;
}

export interface ReadTextParams { path: string; encoding?: 'utf8' }
export interface ReadTextResult { content: string; mtime: number; size: number; encoding: 'utf8' }
export interface ReadBinaryResult { contentBase64: string; mtime: number; size: number }

export interface WriteTextParams {
  path: string;
  content: string;
  /** If set, the write is rejected with PreconditionFailed when the remote mtime differs. */
  expectedMtime?: number;
}
export interface WriteBinaryParams {
  path: string;
  contentBase64: string;
  expectedMtime?: number;
}
export interface AppendTextParams { path: string; content: string }
export interface AppendBinaryParams { path: string; contentBase64: string }
export interface MtimeResult { mtime: number }

export interface MkdirParams { path: string; recursive?: boolean }
export interface RmdirParams { path: string; recursive?: boolean }
export interface RenameParams { oldPath: string; newPath: string }
export interface CopyParams { srcPath: string; destPath: string }

export interface WatchParams { path: string; recursive?: boolean }
export interface WatchResult { subscriptionId: string }
export interface UnwatchParams { subscriptionId: string }

// ─── server-push notifications ───────────────────────────────────────────────

export type FsChangeEvent = 'created' | 'modified' | 'deleted' | 'renamed';

export interface FsChangedParams {
  subscriptionId: string;
  path: string;
  event: FsChangeEvent;
  mtime?: number;
  /** Set iff event === 'renamed'. */
  newPath?: string;
}

export interface ServerNotificationMap {
  'fs.changed': FsChangedParams;
}

export type ServerNotificationName = keyof ServerNotificationMap;

// ─── JSON-RPC envelopes ──────────────────────────────────────────────────────

export interface JsonRpcRequest<M extends MethodName = MethodName> {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params: Params<M>;
}

export interface JsonRpcSuccess<M extends MethodName = MethodName> {
  jsonrpc: '2.0';
  id: number | string;
  result: Result<M>;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<N extends ServerNotificationName = ServerNotificationName> {
  jsonrpc: '2.0';
  method: N;
  params: ServerNotificationMap[N];
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcSuccess
  | JsonRpcError
  | JsonRpcNotification;

// ─── error codes ─────────────────────────────────────────────────────────────

export const ErrorCode = {
  // JSON-RPC 2.0 reserved range.
  ParseError:            -32700,
  InvalidRequest:        -32600,
  MethodNotFound:        -32601,
  InvalidParams:         -32602,
  InternalError:         -32603,
  // obsidian-remote-server custom range (-32000 .. -32099).
  AuthRequired:          -32000,
  AuthInvalid:           -32001,
  FileNotFound:          -32010,
  NotADirectory:         -32011,
  IsADirectory:          -32012,
  Exists:                -32013,
  PermissionDenied:      -32014,
  PathOutsideVault:      -32015,
  PreconditionFailed:    -32020,
  ProtocolVersionTooOld: -32021,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
