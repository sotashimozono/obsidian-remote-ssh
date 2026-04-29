import * as fs from 'fs';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { Duplex } from 'stream';
import type { JumpHostConfig } from '../types';
import type { AuthResolver } from './AuthResolver';
import type { HostKeyStore } from './HostKeyStore';
import { expandHome } from '../util/pathUtils';
import { logger } from '../util/logger';

/**
 * Optional knobs for `createJumpTunnel`. Most callers leave them at
 * defaults; tests inject a mock `Client` factory so the SSH layer
 * doesn't need a real bastion to run.
 */
export interface CreateJumpTunnelOptions {
  /** TOFU verifier shared with the main session. Strongly recommended. */
  hostKeyStore?: HostKeyStore;
  /** Forwarded to ssh2's keepalive on the jump connection. */
  keepaliveIntervalMs?: number;
  /** Forwarded as `readyTimeout` to ssh2's connect. */
  connectTimeoutMs?: number;
  /** Test seam: factory for the underlying ssh2.Client. */
  clientFactory?: () => Pick<
    Client,
    'on' | 'connect' | 'forwardOut' | 'end' | 'destroy'
  > & { destroy?: () => void };
}

/**
 * Open a direct-tcpip channel through a jump host and return it as a
 * Duplex stream. The stream is passed as `sock` to the main `Client`
 * so the primary connection tunnels through without an intermediate
 * local port.
 *
 * The jump connection is kept alive while the returned stream is in
 * use; the jump client tears down when the tunnel stream closes.
 */
export async function createJumpTunnel(
  jump: JumpHostConfig,
  targetHost: string,
  targetPort: number,
  authResolver: AuthResolver,
  options: CreateJumpTunnelOptions = {},
): Promise<Duplex> {
  const factory = options.clientFactory ?? (() => new Client());
  const jumpClient = factory();

  const authConfig = buildJumpAuthConfig(jump, authResolver);
  const config: ConnectConfig = {
    host: jump.host,
    port: jump.port,
    username: jump.username,
    readyTimeout: options.connectTimeoutMs ?? 15_000,
    keepaliveInterval: options.keepaliveIntervalMs,
    ...authConfig,
  };
  if (options.hostKeyStore) {
    const store = options.hostKeyStore;
    config.hostVerifier = (key: Buffer | string) => {
      const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
      return store.verify(jump.host, jump.port, buf);
    };
  }

  // Wait for the jump client to handshake. Both 'ready' and 'error'
  // fire at most once; on error we destroy the client so we don't
  // leak the underlying socket while the rejection unwinds.
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      logger.info(`Jump host ${jump.host}:${jump.port} ready`);
      resolve();
    };
    const onError = (err: Error) => {
      try { jumpClient.destroy?.(); } catch { /* ignore */ }
      reject(new Error(`Jump host "${jump.host}" connect failed: ${err.message}`));
    };
    jumpClient.on('ready', onReady);
    jumpClient.on('error', onError);
    jumpClient.connect(config);
  });

  return new Promise<Duplex>((resolve, reject) => {
    jumpClient.forwardOut(
      '127.0.0.1', 0,
      targetHost, targetPort,
      (err, stream) => {
        if (err) {
          jumpClient.end();
          reject(new Error(
            `Jump tunnel to ${targetHost}:${targetPort} via "${jump.host}" failed: ${err.message}`,
          ));
          return;
        }
        // The forwarded stream owns the jump client lifetime: when
        // the tunnel closes we tear the jump session down so the OS
        // socket isn't left hanging.
        stream.on('close', () => {
          logger.info(`Jump tunnel to ${targetHost}:${targetPort} closed; ending jump client`);
          try { jumpClient.end(); } catch { /* ignore */ }
        });
        resolve(stream);
      },
    );
  });
}

/**
 * Build the auth half of `ConnectConfig` for the jump host. Mirrors
 * `AuthResolver.buildAuthConfig` but for the slimmer
 * `JumpHostConfig` data model (no passphrase, no agent override —
 * extending the model is a separate change).
 */
function buildJumpAuthConfig(
  jump: JumpHostConfig,
  authResolver: AuthResolver,
): Partial<ConnectConfig> {
  switch (jump.authMethod) {
    case 'password': {
      const password = jump.passwordRef
        ? authResolver.getSecret(jump.passwordRef)
        : undefined;
      if (!password) {
        throw new Error(`No password in memory for jump host "${jump.host}"`);
      }
      return { password };
    }
    case 'privateKey': {
      if (!jump.privateKeyPath) {
        throw new Error(`No private key path for jump host "${jump.host}"`);
      }
      const keyPath = expandHome(jump.privateKeyPath);
      let privateKey: Buffer;
      try {
        privateKey = fs.readFileSync(keyPath);
      } catch (e) {
        throw new Error(
          `Cannot read jump host private key at "${keyPath}": ${(e as Error).message}`,
        );
      }
      logger.info(`Jump host auth: using private key ${keyPath}`);
      return { privateKey };
    }
    case 'agent': {
      const socket = process.env.SSH_AUTH_SOCK;
      if (!socket) {
        throw new Error(`SSH_AUTH_SOCK not set; cannot use agent auth for jump host "${jump.host}"`);
      }
      return { agent: socket };
    }
    default:
      // After exhausting the union the field is `never`; widen via String() so
      // the message still surfaces the value if a future case is forgotten.
      throw new Error(`Unknown jump host auth method: ${String(jump.authMethod)}`);
  }
}
