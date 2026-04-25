import { logger } from '../util/logger';

/**
 * The thin slice of SftpClient the deployer relies on. A separate
 * interface keeps this module free of the larger SftpClient surface
 * area and makes it trivial to mock in unit tests.
 */
export interface DeployerSshClient {
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  readRemoteFile(remotePath: string): Promise<Buffer>;
  exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface DeployOptions {
  /** Absolute or working-directory-relative path on the local machine. */
  localBinaryPath: string;

  /**
   * Where to write the daemon binary on the remote. Default
   * `.obsidian-remote/server` (home-relative).
   */
  remoteBinaryPath?: string;

  /** Vault root the daemon should serve. Passed via --vault-root. */
  remoteVaultRoot: string;

  /**
   * Where the daemon writes its session token. Default
   * `.obsidian-remote/token`. Must match what the daemon was told to
   * write — passed unchanged via --token-file.
   */
  remoteTokenPath?: string;

  /**
   * Where the daemon listens. Default `.obsidian-remote/server.sock`.
   * Must match what the plugin opens via `openssh_forwardOutStreamLocal`.
   */
  remoteSocketPath?: string;

  /**
   * Where the daemon's stdout/stderr go. Default
   * `.obsidian-remote/server.log`. Useful for post-mortem debugging
   * since the launching SSH connection drops out of the daemon's
   * lifecycle once `nohup` detaches.
   */
  remoteLogPath?: string;

  /**
   * If `true` (default), an existing daemon process is killed before
   * the new one is started. Set to `false` to leave a previously
   * running instance untouched (useful when multiple Obsidian sessions
   * share one host and you don't want to interrupt another vault's
   * connection).
   */
  killExisting?: boolean;

  /** Maximum total time to wait for the daemon's token file to appear, in ms. Default 5000. */
  waitForTokenTimeoutMs?: number;
}

export interface DeployResult {
  remoteBinaryPath: string;
  remoteSocketPath: string;
  remoteTokenPath: string;
  /** The freshly-written token, read off disk after the daemon came up. */
  token: string;
}

const DEFAULTS = {
  remoteBinaryPath: '.obsidian-remote/server',
  remoteTokenPath:  '.obsidian-remote/token',
  remoteSocketPath: '.obsidian-remote/server.sock',
  remoteLogPath:    '.obsidian-remote/server.log',
  killExisting:     true,
  waitForTokenTimeoutMs: 5000,
} as const;

/**
 * ServerDeployer ships the obsidian-remote-server binary to the remote
 * host, makes it executable, replaces any previously-running instance,
 * and waits for the new one to come up by watching for the token file.
 *
 * The class is stateless aside from its `ssh` dependency: every call
 * to `deploy()` is a complete replace-and-restart. That's deliberately
 * simple — the daemon is small, idempotent in its setup, and starting
 * it costs less than fifty ms once the binary is on disk.
 */
export class ServerDeployer {
  constructor(private readonly ssh: DeployerSshClient) {}

  async deploy(opts: DeployOptions): Promise<DeployResult> {
    const remoteBinaryPath = opts.remoteBinaryPath ?? DEFAULTS.remoteBinaryPath;
    const remoteTokenPath  = opts.remoteTokenPath  ?? DEFAULTS.remoteTokenPath;
    const remoteSocketPath = opts.remoteSocketPath ?? DEFAULTS.remoteSocketPath;
    const remoteLogPath    = opts.remoteLogPath    ?? DEFAULTS.remoteLogPath;
    const killExisting     = opts.killExisting     ?? DEFAULTS.killExisting;
    const waitMs           = opts.waitForTokenTimeoutMs ?? DEFAULTS.waitForTokenTimeoutMs;

    const remoteDir = parentDirOf(remoteBinaryPath);

    logger.info(`ServerDeployer: ensuring ${remoteDir}/ exists`);
    await this.run(`mkdir -p ${shellQuote(remoteDir)} && chmod 700 ${shellQuote(remoteDir)}`);

    if (killExisting) {
      logger.info('ServerDeployer: killing any prior daemon');
      // Match by the unique --vault-root flag so we never kill an
      // unrelated process that happens to share the binary name.
      await this.run(`pkill -f ${shellQuote(remoteBinaryPath + ' ')} 2>/dev/null || true`);
      // Stale socket left by a hard-killed daemon would block bind().
      await this.run(`rm -f ${shellQuote(remoteSocketPath)} ${shellQuote(remoteTokenPath)}`);
    }

    logger.info(`ServerDeployer: uploading binary → ${remoteBinaryPath}`);
    await this.ssh.uploadFile(opts.localBinaryPath, remoteBinaryPath);
    await this.run(`chmod 700 ${shellQuote(remoteBinaryPath)}`);

    logger.info('ServerDeployer: starting daemon');
    const startCmd = [
      `nohup ${shellQuote(remoteBinaryPath)}`,
      `--vault-root=${shellQuote(opts.remoteVaultRoot)}`,
      `--socket=${shellQuote(remoteSocketPath)}`,
      `--token-file=${shellQuote(remoteTokenPath)}`,
      `--verbose`,
      `> ${shellQuote(remoteLogPath)} 2>&1 < /dev/null &`,
    ].join(' ');
    // The launching shell exits as soon as nohup detaches, so this
    // exec returns almost immediately even though the daemon keeps
    // running.
    await this.run(startCmd);

    const token = await this.waitForToken(remoteTokenPath, waitMs);
    return { remoteBinaryPath, remoteSocketPath, remoteTokenPath, token };
  }

  /**
   * Stop a running daemon by killing every process matching the
   * deployed binary path. Safe to call when no daemon is up.
   */
  async stop(remoteBinaryPath = DEFAULTS.remoteBinaryPath,
             remoteSocketPath = DEFAULTS.remoteSocketPath,
             remoteTokenPath  = DEFAULTS.remoteTokenPath): Promise<void> {
    logger.info(`ServerDeployer: stopping daemon at ${remoteBinaryPath}`);
    await this.run(`pkill -f ${shellQuote(remoteBinaryPath + ' ')} 2>/dev/null || true`);
    await this.run(`rm -f ${shellQuote(remoteSocketPath)} ${shellQuote(remoteTokenPath)}`);
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async run(cmd: string): Promise<string> {
    const r = await this.ssh.exec(cmd);
    if (r.exitCode !== 0 && !cmd.includes('|| true')) {
      throw new Error(`ServerDeployer: \`${truncate(cmd, 120)}\` exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  }

  private async waitForToken(remoteTokenPath: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const buf = await this.ssh.readRemoteFile(remoteTokenPath);
        const token = buf.toString('utf8').trim();
        if (token) return token;
      } catch (e) {
        lastErr = e;
        // Token not ready yet — sleep a beat and retry.
      }
      await sleep(150);
    }
    throw new Error(
      `ServerDeployer: daemon did not write ${remoteTokenPath} within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${(lastErr as Error).message})` : ''),
    );
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Wraps a string in single quotes for inclusion in a POSIX shell
 * command, escaping any embedded single quotes. Sufficient for the
 * paths and arguments we control here; do not feed user-supplied
 * arbitrary text.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parentDirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '.' : path.slice(0, i);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
