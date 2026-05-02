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

export enum ErrorCode {
  ParseError         = -32700,
  InvalidRequest     = -32600,
  MethodNotFound     = -32601,
  InvalidParams      = -32602,
  InternalError      = -32603,
  AuthRequired       = -32010,
  AuthInvalid        = -32011,
  FileNotFound       = -32020,
  NotADirectory      = -32021,
  IsADirectory       = -32022,
  Exists             = -32023,
  PermissionDenied   = -32030,
  PathOutsideVault   = -32031,
  PreconditionFailed = -32040,
  ProtocolVersionTooOld = -32050,
}
