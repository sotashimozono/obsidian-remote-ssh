import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { JumpHostConfig } from '../types';
import type { AuthResolver } from './AuthResolver';
import { logger } from '../util/logger';

/**
 * Opens a direct-tcpip channel through a jump host and returns it as a
 * duplex stream.  The stream is passed as `sock` to the main Client so the
 * primary connection tunnels through without an intermediate local port.
 */
export async function createJumpTunnel(
  jump: JumpHostConfig,
  targetHost: string,
  targetPort: number,
  authResolver: AuthResolver,
): Promise<import('stream').Duplex> {
  const jumpClient = new Client();

  const authConfig = buildJumpAuthConfig(jump, authResolver);

  const config: ConnectConfig = {
    host: jump.host,
    port: jump.port,
    username: jump.username,
    readyTimeout: 15000,
    ...authConfig,
  };

  await new Promise<void>((resolve, reject) => {
    jumpClient.on('ready', () => {
      logger.info(`Jump host ${jump.host} ready`);
      resolve();
    });
    jumpClient.on('error', reject);
    jumpClient.connect(config);
  });

  return new Promise((resolve, reject) => {
    jumpClient.forwardOut(
      '127.0.0.1', 0,
      targetHost, targetPort,
      (err, stream) => {
        if (err) {
          jumpClient.end();
          reject(new Error(`Jump tunnel to ${targetHost}:${targetPort} failed: ${err.message}`));
          return;
        }
        // Clean up jump client when the tunnel stream closes
        stream.on('close', () => {
          logger.info(`Jump tunnel closed, ending jump client`);
          jumpClient.end();
        });
        resolve(stream as unknown as import('stream').Duplex);
      },
    );
  });
}

function buildJumpAuthConfig(
  jump: JumpHostConfig,
  authResolver: AuthResolver,
): Partial<ConnectConfig> {
  switch (jump.authMethod) {
    case 'password': {
      const password = jump.passwordRef
        ? authResolver.getSecret(jump.passwordRef)
        : undefined;
      if (!password) throw new Error(`No password in memory for jump host "${jump.host}"`);
      return { password };
    }
    case 'privateKey': {
      if (!jump.privateKeyPath) throw new Error(`No private key path for jump host "${jump.host}"`);
      const fs = require('fs') as typeof import('fs');
      return { privateKey: fs.readFileSync(jump.privateKeyPath) };
    }
    case 'agent': {
      const socket = process.env.SSH_AUTH_SOCK;
      if (!socket) throw new Error('SSH_AUTH_SOCK not set for jump host agent auth');
      return { agent: socket };
    }
    default:
      throw new Error(`Unknown jump host auth method: ${(jump as JumpHostConfig).authMethod}`);
  }
}
