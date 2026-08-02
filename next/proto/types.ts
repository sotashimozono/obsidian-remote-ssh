/**
 * Shared JSON-RPC protocol types — platform-agnostic canonical copy.
 *
 * This file is the `next/` authoritative version, shared between Desktop,
 * Mobile, and the Relay server. Mirrors plugin/src/proto/types.ts plus
 * Relay-specific additions.
 *
 * When the spec changes, update plugin/src/proto/types.ts, this file,
 * and server/internal/proto/types.go in the same PR.
 */

export const PROTOCOL_VERSION = 1;

/** Protocol version spoken by the WebSocket Relay layer. */
export const RELAY_PROTOCOL_VERSION = 1;

// ─── core shapes ─────────────────────────────────────────────────────────────

export interface ServerInfo {
  version: string;
  protocolVersion: number;
  capabilities: string[];
  vaultRoot: string;
}

export interface Stat {
  type: 'file' | 'folder';
  mtime: number;
  size: number;
  mode: number;
}

export interface Entry {
  name: string;
  type: 'file' | 'folder' | 'symlink';
  mtime: number;
  size: number;
}

// ─── Relay handshake ─────────────────────────────────────────────────────────

/** Sent by Mobile → Relay immediately after WebSocket open. */
export interface RelayHello {
  sessionId: string;
  /** Token issued by the relay session API. */
  token: string;
  clientVersion: string;
}

/** Relay → Mobile response to RelayHello. */
export interface RelayWelcome {
  relayVersion: string;
  /** True if the relay successfully opened SSH to the remote host. */
  sshConnected: boolean;
  error?: string;
}

// ─── method tables ───────────────────────────────────────────────────────────

export type MethodName =
  | 'auth'
  | 'server.info'
  | 'extension.schema'
  | 'extension.invoke'
  | 'extension.kill'
  | 'cli.kill'
  | 'fs.stat'
  | 'fs.exists'
  | 'fs.list'
  | 'fs.walk'
  | 'fs.readText'
  | 'fs.readBinary'
  | 'fs.readBinaryRange'
  | 'fs.thumbnail'
  | 'fs.write'
  | 'fs.writeBinary'
  | 'fs.append'
  | 'fs.appendBinary'
  | 'fs.mkdir'
  | 'fs.remove'
  | 'fs.rmdir'
  | 'fs.rename'
  | 'fs.copy'
  | 'fs.watch'
  | 'fs.unwatch';

export interface ExtensionArgRule {
  name: string;
  required?: boolean;
  pattern?: string;
  maxLength?: number;
  allowFlags?: boolean;
}

export interface ExtensionCapability {
  tool: string;
  description?: string;
  command: string;
  sha256: string;
  args?: ExtensionArgRule[];
  allowWorkingDir?: boolean;
  persistDefault?: boolean;
  outputMode?: 'batch' | 'single';
}

export interface ExtensionSchemaResult {
  version: number;
  manifestSha256: string;
  extensions: ExtensionCapability[];
}

export interface ExtensionInvokeParams {
  invocationId?: string;
  tool: string;
  args?: Record<string, string>;
  workingDir?: string;
  persist?: boolean;
  resumeFrom?: number;
}

export interface ExtensionInvokeResult {
  invocationId: string;
  accepted: boolean;
}

export interface ExtensionKillParams {
  invocationId: string;
}

export interface ExtensionKillResult {
  invocationId: string;
  killed: boolean;
}

export interface CliOutputParams {
  invocationId: string;
  stream: 'stdout' | 'stderr';
  data: string;
  seq?: number;
}

export interface CliOutputBatchItem {
  stream: 'stdout' | 'stderr';
  data: string;
  seq?: number;
}

export interface CliOutputBatchParams {
  invocationId: string;
  items: CliOutputBatchItem[];
}

export interface CliDoneParams {
  invocationId: string;
  exitCode: number;
  signal?: string;
}

export enum ErrorCode {
  ParseError         = -32700,
  InvalidRequest     = -32600,
  MethodNotFound     = -32601,
  InvalidParams      = -32602,
  InternalError      = -32603,
  AuthRequired       = -32000,
  AuthInvalid        = -32001,
  FileNotFound       = -32010,
  NotADirectory      = -32011,
  IsADirectory       = -32012,
  Exists             = -32013,
  PermissionDenied   = -32014,
  PathOutsideVault   = -32015,
  PreconditionFailed = -32020,
  ProtocolVersionTooOld = -32021,
  ExtensionDenied    = -32030,
  BinaryHashMismatch = -32031,
}
