import { ErrorCode } from '../proto/types';

/**
 * RpcError is thrown from `RpcClient.call` when the daemon returned a
 * JSON-RPC error envelope, and from the client itself when the stream
 * closed before a call could be answered.
 *
 * Prefer comparing against `ErrorCode.*` values from `proto/types.ts`
 * rather than raw numbers; the code constants are the source of truth
 * for what the daemon emits.
 */
export class RpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  /**
   * Matches one of the known error codes. Handy for `switch` blocks
   * that want to react to, e.g., `FileNotFound` without unwrapping
   * arbitrary integers.
   */
  is(code: (typeof ErrorCode)[keyof typeof ErrorCode]): boolean {
    return this.code === code;
  }
}
