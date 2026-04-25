import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  ErrorCode,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcError,
  type JsonRpcNotification,
  type Params,
  type Result,
} from '../src/proto/types';

/**
 * These tests don't validate behavior — they exist to make the proto
 * types actually reachable through the test runner, and to pin a few
 * invariants we expect to keep in lockstep with the Go mirror
 * (`server/internal/proto/types.go`). If any of them fails, update
 * both sides in the same PR.
 */
describe('proto types', () => {
  it('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('exposes the expected error code constants', () => {
    expect(ErrorCode.ParseError).toBe(-32700);
    expect(ErrorCode.InvalidRequest).toBe(-32600);
    expect(ErrorCode.MethodNotFound).toBe(-32601);
    expect(ErrorCode.InvalidParams).toBe(-32602);
    expect(ErrorCode.InternalError).toBe(-32603);
    expect(ErrorCode.AuthRequired).toBe(-32000);
    expect(ErrorCode.AuthInvalid).toBe(-32001);
    expect(ErrorCode.FileNotFound).toBe(-32010);
    expect(ErrorCode.NotADirectory).toBe(-32011);
    expect(ErrorCode.IsADirectory).toBe(-32012);
    expect(ErrorCode.Exists).toBe(-32013);
    expect(ErrorCode.PermissionDenied).toBe(-32014);
    expect(ErrorCode.PathOutsideVault).toBe(-32015);
    expect(ErrorCode.PreconditionFailed).toBe(-32020);
    expect(ErrorCode.ProtocolVersionTooOld).toBe(-32021);
  });

  it('typechecks a well-formed request/response/error/notification (compile-time assertion)', () => {
    const statParams: Params<'fs.stat'> = { path: 'note.md' };
    const statOk: Result<'fs.stat'> = {
      type: 'file', mtime: 1_700_000_000_000, size: 42, mode: 0o100644,
    };
    const statMissing: Result<'fs.stat'> = null;

    const req: JsonRpcRequest<'fs.stat'> = {
      jsonrpc: '2.0', id: 1, method: 'fs.stat', params: statParams,
    };
    const ok: JsonRpcSuccess<'fs.stat'> = {
      jsonrpc: '2.0', id: 1, result: statOk,
    };
    const err: JsonRpcError = {
      jsonrpc: '2.0', id: 1, error: { code: ErrorCode.FileNotFound, message: 'no such file' },
    };
    const note: JsonRpcNotification<'fs.changed'> = {
      jsonrpc: '2.0',
      method: 'fs.changed',
      params: { subscriptionId: 's1', path: 'note.md', event: 'modified', mtime: 123 },
    };

    // Runtime assertions are superficial; the real win is that TypeScript
    // refused to compile this block if any type drifted.
    expect(req.method).toBe('fs.stat');
    expect(ok.result).toEqual(statOk);
    expect(statMissing).toBeNull();
    expect(err.error.code).toBe(ErrorCode.FileNotFound);
    expect(note.params.event).toBe('modified');
  });
});
