import { describe, it, expect } from 'vitest';
import { RpcError } from '../src/transport/RpcError';
import { isPreconditionFailed } from '../src/proto/rpcError';
import { ErrorCode } from '../src/proto/types';

describe('RpcError', () => {
  it('sets name, code, message, and data from constructor arguments', () => {
    const e = new RpcError(ErrorCode.FileNotFound, 'not found', { path: 'foo.md' });
    expect(e.name).toBe('RpcError');
    expect(e.code).toBe(ErrorCode.FileNotFound);
    expect(e.message).toBe('not found');
    expect(e.data).toEqual({ path: 'foo.md' });
  });

  it('data is undefined when the third argument is omitted', () => {
    const e = new RpcError(ErrorCode.InternalError, 'oops');
    expect(e.data).toBeUndefined();
  });

  it('is an instance of Error so catch blocks that check instanceof Error still catch it', () => {
    expect(new RpcError(ErrorCode.InternalError, 'err')).toBeInstanceOf(Error);
  });

  it('is() returns true when the code matches', () => {
    const e = new RpcError(ErrorCode.FileNotFound, 'not found');
    expect(e.is(ErrorCode.FileNotFound)).toBe(true);
  });

  it('is() returns false when the code does not match', () => {
    const e = new RpcError(ErrorCode.FileNotFound, 'not found');
    expect(e.is(ErrorCode.PermissionDenied)).toBe(false);
  });

  it('is() distinguishes between close numeric codes (AuthRequired vs AuthInvalid)', () => {
    const e = new RpcError(ErrorCode.AuthRequired, 'auth required');
    expect(e.is(ErrorCode.AuthRequired)).toBe(true);
    expect(e.is(ErrorCode.AuthInvalid)).toBe(false);
  });
});

describe('isPreconditionFailed', () => {
  it('returns true when the object has code === PreconditionFailed', () => {
    expect(isPreconditionFailed({ code: ErrorCode.PreconditionFailed })).toBe(true);
  });

  it('returns false for a different numeric error code', () => {
    expect(isPreconditionFailed({ code: ErrorCode.FileNotFound })).toBe(false);
  });

  it('returns false when the object has no code property', () => {
    expect(isPreconditionFailed({ message: 'oops' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isPreconditionFailed(null)).toBe(false);
  });

  it('returns false for a string primitive', () => {
    expect(isPreconditionFailed('PreconditionFailed')).toBe(false);
  });

  it('returns false for a number primitive', () => {
    expect(isPreconditionFailed(ErrorCode.PreconditionFailed)).toBe(false);
  });

  it('works with a plain object that duck-types a transport error (no RpcError import needed)', () => {
    // The function is duck-typed on purpose — SFTP errors arrive as
    // plain objects with a numeric `code` field, not as RpcError instances.
    const sftpStyle = { code: ErrorCode.PreconditionFailed, message: 'mtime changed' };
    expect(isPreconditionFailed(sftpStyle)).toBe(true);
  });
});
