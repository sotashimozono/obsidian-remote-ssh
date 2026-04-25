import type { Duplex } from 'stream';
import { FramedDuplex } from './framing';
import { RpcClient } from './RpcClient';
import { RpcError } from './RpcError';
import { PROTOCOL_VERSION, ErrorCode } from '../proto/types';
import type { ServerInfo } from '../proto/types';
import { logger } from '../util/logger';

/**
 * Concrete transport the α path needs: a Duplex stream reaching the
 * daemon, plus the session token the daemon wrote to disk at startup.
 *
 * Typical construction uses `SftpClient.openUnixStream` +
 * `SftpClient.readRemoteFile`, but the shape is abstract so tests can
 * pass an in-memory duplex + a literal token.
 */
export interface RpcConnectionInputs {
  stream: Duplex;
  token: string;
}

/**
 * Full result of a successful RPC handshake: the authenticated client
 * plus the daemon's advertised capabilities.
 */
export interface RpcConnection {
  rpc: RpcClient;
  info: ServerInfo;
  close(): void;
}

/**
 * Open an authenticated RPC session on a stream already pointing at
 * the daemon's unix socket.
 *
 * Steps, in order:
 *   1. Wrap the stream in a FramedDuplex.
 *   2. Wrap that in an RpcClient.
 *   3. Call `auth { token }`.
 *   4. Call `server.info` and verify the protocol version.
 *   5. Return the client + info.
 *
 * If any step fails, the stream is closed before the error is
 * re-thrown so the caller never has to clean up partial state.
 */
export async function establishRpcConnection(inputs: RpcConnectionInputs): Promise<RpcConnection> {
  const framed = new FramedDuplex(inputs.stream);
  const rpc = new RpcClient(framed);
  const cleanupOnFailure = (e: unknown): never => {
    try { rpc.close(); } catch { /* ignore */ }
    throw e;
  };

  try {
    const authResult = await rpc.call('auth', { token: inputs.token });
    if (!authResult.ok) {
      throw new RpcError(ErrorCode.AuthInvalid, 'daemon refused auth token');
    }
    logger.info('RpcConnection: auth accepted');
  } catch (e) {
    return cleanupOnFailure(e);
  }

  let info: ServerInfo;
  try {
    info = await rpc.call('server.info', {});
  } catch (e) {
    return cleanupOnFailure(e);
  }

  if (info.protocolVersion !== PROTOCOL_VERSION) {
    cleanupOnFailure(
      new RpcError(
        ErrorCode.ProtocolVersionTooOld,
        `daemon speaks protocol v${info.protocolVersion}, client needs v${PROTOCOL_VERSION}`,
      ),
    );
  }
  logger.info(
    `RpcConnection: daemon ${info.version} (protocol v${info.protocolVersion}); ` +
    `capabilities=[${info.capabilities.join(', ')}]`,
  );

  return {
    rpc,
    info,
    close: () => rpc.close(),
  };
}
