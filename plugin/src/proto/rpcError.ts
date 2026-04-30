import { ErrorCode } from './types';

/**
 * Recognise the `PreconditionFailed` RPC error the daemon returns
 * when an operation gated by `expectedMtime` finds the remote mtime
 * has moved (most commonly: `fs.write` rejected mid-edit, or
 * `fs.readBinaryRange` rejected mid-scrub). Duck-typed against the
 * `code` property so callers don't have to import the transport's
 * concrete `RpcError` class — the SFTP path also reaches some of
 * the same code paths and wraps its own errors differently.
 */
export function isPreconditionFailed(e: unknown): boolean {
  return typeof e === 'object'
      && e !== null
      && 'code' in e
      && e.code === ErrorCode.PreconditionFailed;
}
