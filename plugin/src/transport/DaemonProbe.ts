import type { Duplex } from 'stream';
import type { RpcConnection } from './RpcConnection';
import { establishRpcConnection } from './RpcConnection';
import { logger } from '../util/logger';

/**
 * Narrow slice of SftpClient the probe needs. Same shape used by
 * ServerDeployer's `DeployerSshClient` plus `openUnixStream` for the
 * RPC handshake. Kept minimal so unit tests can mock it without
 * standing up the full SftpClient class.
 */
export interface ProbeSshClient {
  exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readRemoteFile(remotePath: string): Promise<Buffer>;
  openUnixStream(socketPath: string): Promise<Duplex>;
}

/**
 * Probe whether a healthy, protocol-compatible obsidian-remote-server
 * daemon is already running on the remote, and if so, return a fresh
 * RpcConnection bound to it. The caller can then skip the
 * kill+upload+restart cycle entirely (see #131 — "Daemon version
 * check on connect").
 *
 * The check is conservative: we return null on ANY uncertainty
 * (socket missing, token unreadable, openUnixStream fails, handshake
 * fails, protocol mismatch). The caller falls through to the normal
 * deploy flow on null. Worst case = one extra round-trip per
 * connect; best case (the common one for shared hosts) = one daemon
 * survives across N reconnect storms instead of being murdered each
 * time.
 *
 * Limitation deliberately out of scope for this PR: if session A
 * deployed the daemon and session B reused it via this probe, then A
 * disconnects, A's `daemonDeployer.stop()` still kills the daemon
 * (because A still holds the deployer state from its own deploy
 * call). True multi-session reference counting is a follow-up;
 * tracked in the issue's "PR 2" bucket.
 *
 * @param ssh         the SshClient (typically the plugin's SftpClient).
 * @param socketPath  absolute remote path to the daemon's unix socket
 *                    (e.g. `/home/user/.obsidian-remote/server.sock`).
 * @param tokenPath   absolute remote path to the daemon's token file
 *                    (e.g. `/home/user/.obsidian-remote/token`).
 * @returns a live `RpcConnection` if the existing daemon is healthy
 *          and protocol-compatible, otherwise `null`.
 */
export async function tryReuseExistingDaemon(
  ssh: ProbeSshClient,
  socketPath: string,
  tokenPath: string,
): Promise<RpcConnection | null> {
  // Step 1: socket present? `test -S` returns 0 only if the path
  // exists and is a unix socket — distinguishes a live daemon from a
  // stale leftover regular file.
  const socketCheck = await ssh.exec(
    `test -S ${shellQuote(socketPath)} && echo OK || echo NO`,
  ).catch((e) => {
    logger.info(`tryReuseExistingDaemon: socket check exec failed (${(e as Error).message})`);
    return null;
  });
  if (!socketCheck || socketCheck.stdout.trim() !== 'OK') {
    return null;
  }

  // Step 2: token readable? An existing daemon must have written its
  // token, otherwise our auth call will fail anyway.
  let token: string;
  try {
    const buf = await ssh.readRemoteFile(tokenPath);
    token = buf.toString('utf8').trim();
    if (!token) return null;
  } catch (e) {
    logger.info(`tryReuseExistingDaemon: token read failed (${(e as Error).message})`);
    return null;
  }

  // Step 3: open a unix-socket stream toward the existing daemon.
  let stream: Duplex;
  try {
    stream = await ssh.openUnixStream(socketPath);
  } catch (e) {
    logger.info(
      `tryReuseExistingDaemon: openUnixStream failed (${(e as Error).message}) — falling through to deploy`,
    );
    return null;
  }

  // Step 4: handshake. `establishRpcConnection` does auth + server.info
  // and rejects on protocol mismatch — so if we get a successful
  // promise here, the daemon is fully compatible with the client.
  try {
    const conn = await establishRpcConnection({ stream, token });
    logger.info(
      `tryReuseExistingDaemon: reused existing daemon ${conn.info.version} ` +
      `(protocol v${conn.info.protocolVersion})`,
    );
    return conn;
  } catch (e) {
    logger.info(
      `tryReuseExistingDaemon: handshake failed (${(e as Error).message}) — falling through to deploy`,
    );
    // establishRpcConnection closes the rpc on its own failure path,
    // but if the stream was created successfully and the failure
    // happened before/during framing, we still want to make sure no
    // half-open socket is left behind.
    try { stream.destroy(); } catch { /* already gone */ }
    return null;
  }
}

/**
 * POSIX shell single-quote escape. Same posture as ServerDeployer's
 * `shellQuote` — sufficient for the controlled paths we feed in
 * (resolved absolute remote paths, never user-supplied free text).
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
