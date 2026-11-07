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

/** SFTP's `SSH_FX_NO_SUCH_FILE`, which ssh2 puts in the error's `code`. */
const SFTP_NO_SUCH_FILE = 2;

/**
 * Recognise "the file doesn't exist" from either transport: the daemon's
 * `FileNotFound`, SFTP's no-such-file status, or a local `ENOENT`. Every
 * other failure (permission, timeout, a dropped session) is not a missing
 * file. Duck-typed for the same reason as `isPreconditionFailed`.
 */
export function isFileNotFound(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e)) return false;
  return e.code === ErrorCode.FileNotFound || e.code === SFTP_NO_SUCH_FILE || e.code === 'ENOENT';
}
