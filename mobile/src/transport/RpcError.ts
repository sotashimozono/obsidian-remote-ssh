/**
 * Mirrors plugin/src/transport/RpcError.ts without any Node.js imports.
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
}
