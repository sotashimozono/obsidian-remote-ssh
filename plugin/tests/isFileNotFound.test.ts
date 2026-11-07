import { describe, it, expect } from 'vitest';
import { isFileNotFound } from '../src/proto/rpcError';
import { RpcError } from '../src/transport/RpcError';
import { ErrorCode } from '../src/proto/types';

describe('isFileNotFound', () => {
  it.each([
    ['the daemon\'s FileNotFound', new RpcError(ErrorCode.FileNotFound, 'no such file: a.md')],
    ['SFTP NO_SUCH_FILE (ssh2 puts the status in code)', Object.assign(new Error('No such file'), { code: 2 })],
    ['a local ENOENT', Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })],
  ])('is true for %s', (_l, e) => {
    expect(isFileNotFound(e)).toBe(true);
  });

  // Anything else must not read as "missing": an append would then replace
  // the file with just the appended bytes.
  it.each([
    ['SFTP PERMISSION_DENIED', Object.assign(new Error('Permission denied'), { code: 3 })],
    ['another daemon error', new RpcError(ErrorCode.PreconditionFailed, 'mtime moved')],
    ['an error with no code (reconnecting, disconnected)', new Error('Remote SSH: reconnecting')],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ENOENT'],
    ['a bare object', {}],
  ])('is false for %s', (_l, e) => {
    expect(isFileNotFound(e)).toBe(false);
  });
});
