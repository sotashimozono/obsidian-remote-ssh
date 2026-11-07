import * as fs from 'fs';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { Duplex } from 'stream';
import type { JumpHostConfig } from '../types';
import type { AuthResolver } from './AuthResolver';
import type { HostKeyMismatchHandler, HostKeyStore } from './HostKeyStore';
import { expandHome } from '../util/pathUtils';
import { logger } from '../util/logger';
import { errorMessage } from "../util/errorMessage";
import { certificateFilePath, loadDiskCertificate } from './DiskCertificate';
import { enableCertificateAuth } from './certificateAuth';

/**
 * Optional knobs for `createJumpTunnel`. Most callers leave them at
 * defaults; tests inject a mock `Client` factory so the SSH layer
 * doesn't need a real bastion to run.
 */
export interface CreateJumpTunnelOptions {
  /** TOFU verifier shared with the main session. Strongly recommended. */
  hostKeyStore?: HostKeyStore;
  /**
   * Optional. When supplied alongside `hostKeyStore`, a host-key
   * mismatch on the jump connection surfaces this callback (typically
   * the same `HostKeyMismatchModal` the main session uses) instead of
   * failing closed. Without it, the jump-host hostVerifier keeps the
   * existing sync `verify()` path — fail-closed on mismatch.
   *
   * The callback's contract is identical to {@link HostKeyMismatchHandler}:
   * `'trust'` → forget the old jump-host fingerprint, pin the new one,
   * proceed; `'abort'` → leave the pin untouched and refuse the
   * tunnel handshake.
   */
  hostKeyMismatchHandler?: HostKeyMismatchHandler;
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

  // Certificate support for a CA-issued bastion key + `<key>-cert.pub` (#536),
  // mirroring the target client. Inert unless an identity is a certificate.
  enableCertificateAuth(jumpClient as unknown as Client);

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
    // Mirror SftpClient (#132): switch to ssh2's async HostVerifier
    // overload when a mismatch handler is wired so the user can be
    // prompted on a jump-host fingerprint change instead of getting
    // a generic "Jump host connect failed" error. Without a handler,
    // the existing sync verify() path stays in place — fail-closed
    // on mismatch, no async surface, identical to today.
    const mismatchHandler = options.hostKeyMismatchHandler;
    if (mismatchHandler) {
      config.hostVerifier = (key: Buffer, verify: (valid: boolean) => void): void => {
        const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
        store.verifyAsync(jump.host, jump.port, buf, mismatchHandler).then(verify, (e: unknown) => {
          // verifyAsync swallows handler errors internally; this is a
          // defence-in-depth path for impossible failures.
          logger.warn(
            `Jump host hostVerifier rejected unexpectedly for ` +
            `${jump.host}:${jump.port}: ${errorMessage(e)}`,
          );
          verify(false);
        });
      };
    } else {
      config.hostVerifier = (key: Buffer | string): boolean => {
        const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
        return store.verify(jump.host, jump.port, buf);
      };
    }
  }

  /** The bastion's last complaint, so the tunnel's death can name a cause. */
  let lastJumpError: Error | null = null;

  // Wait for the jump client to handshake. Both 'ready' and 'error'
  // fire at most once; on error we destroy the client so we don't
  // leak the underlying socket while the rejection unwinds.
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      logger.info(`Jump host ${jump.host}:${jump.port} ready`);
      resolve();
    };
    const onError = (err: Error) => {
      // Logged, not merely rejected. This handler stays attached for the
      // life of the jump session, and once the promise has settled `reject`
      // is a silent no-op — so a bastion dropping mid-session would tear the
      // tunnel down here and leave no record of why. Downstream, all anyone
      // saw was the TARGET host's connection closing, which points at the
      // wrong machine.
      lastJumpError = err;
      logger.warn(`Jump host ${jump.host}:${jump.port} error: ${err.message}`);
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
        // A forwarded channel whose far end goes away emits `end` and stops
        // there: the bastion is still healthy, so ssh2 has no reason to
        // close the channel. But `end` alone never reaches ssh2's outer
        // `Client` as a `close`, and `close` is the only event
        // `SftpClient` reconnects on — so a target that restarted behind a
        // working bastion left the session looking live indefinitely.
        //
        // The same defect ProxyCommandTunnel had, reached differently, and
        // missed for the same reason: the only test that had ever dropped a
        // jump session dropped the BASTION, which tears every channel down
        // and hides this case entirely.
        //
        // Ending our own half lets the Duplex auto-destroy once both
        // directions are finished, so `end` still arrives first and nothing
        // in flight is lost.
        stream.on('end', () => {
          if (lastJumpError) {
            // ssh2 types a Channel's `destroy()` as taking nothing, but it
            // is a Duplex and carries the error through to `'error'` — the
            // only way this route can say why it ended.
            (stream as unknown as Duplex).destroy(lastJumpError);
            return;
          }
          stream.end();
        });

        // The forwarded stream owns the jump client lifetime: when
        // the tunnel closes we tear the jump session down so the OS
        // socket isn't left hanging.
        stream.on('close', () => {
          // At `warn` with the bastion's reason when there is one: this
          // closing is how a multi-hop session ends, and "the jump host
          // died" and "the target went away" are the same line without it.
          if (lastJumpError) {
            logger.warn(
              `Jump tunnel to ${targetHost}:${targetPort} closed after a jump-host ` +
              `failure (${jump.host}: ${lastJumpError.message}); ending jump client`,
            );
          } else {
            logger.info(`Jump tunnel to ${targetHost}:${targetPort} closed; ending jump client`);
          }
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
          `Cannot read jump host private key at "${keyPath}": ${errorMessage(e)}`,
        );
      }
      // As with the target host: a sibling `<key>-cert.pub` is presented via
      // the local signer, and the bare key is offered alongside it. ssh2 tries
      // the bare key first (`publickey`) and the certificate second (`agent`).
      //
      // Caveat, since `JumpHostConfig` carries no passphrase: with an ENCRYPTED
      // bastion key `loadDiskCertificate` can't parse it, so the certificate is
      // skipped with a warning — and the bare-key fallback can't decrypt it
      // either, so neither succeeds. Not a regression (this path never had a
      // passphrase), but a user with an encrypted jump key + cert will see the
      // jump fail without an obvious reason; a passphrase field is future work.
      const certAgent = loadDiskCertificate(keyPath, privateKey);
      if (certAgent) {
        logger.info(`Jump host auth: using certificate ${certificateFilePath(keyPath)} (bare key ${keyPath} offered as fallback)`);
        return { agent: certAgent, privateKey };
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
