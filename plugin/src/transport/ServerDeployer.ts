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
  /**
   * Resolve and cache the remote `$HOME`. Used to absolutise daemon
   * paths so OpenSSH's direct-streamlocal forwarding (which has no
   * concept of CWD on the sshd side) can find the unix socket.
   */
  getRemoteHome(): Promise<string>;
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
  /**
   * Absolutised paths from the most recent successful `deploy()`. Kept
   * so `stop()` can target exactly what was started — pkill matching
   * the absolute argv prevents misses if the user later passes custom
   * paths, and the socket/token cleanup uses the same paths the daemon
   * actually wrote.
   */
  private deployedPaths: { binary: string; socket: string; token: string } | null = null;

  constructor(private readonly ssh: DeployerSshClient) {}

  async deploy(opts: DeployOptions): Promise<DeployResult> {
    // Absolutise every path against the remote's $HOME up-front. We
    // never read or hardcode a specific shape (`/home/...`,
    // `/Users/...`, container paths); the actual remote answers.
    const home = await this.ssh.getRemoteHome();
    const remoteBinaryPath = resolveRemotePath(opts.remoteBinaryPath ?? DEFAULTS.remoteBinaryPath, home);
    const remoteTokenPath  = resolveRemotePath(opts.remoteTokenPath  ?? DEFAULTS.remoteTokenPath,  home);
    const remoteSocketPath = resolveRemotePath(opts.remoteSocketPath ?? DEFAULTS.remoteSocketPath, home);
    const remoteLogPath    = resolveRemotePath(opts.remoteLogPath    ?? DEFAULTS.remoteLogPath,    home);
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
    this.deployedPaths = { binary: remoteBinaryPath, socket: remoteSocketPath, token: remoteTokenPath };
    return { remoteBinaryPath, remoteSocketPath, remoteTokenPath, token };
  }

  /**
   * Stop the daemon launched by the most recent `deploy()`. Safe to
   * call when nothing was deployed (no-op). Targets the exact absolute
   * paths used at deploy time so it never misses or cleans up the
   * wrong process.
   */
  async stop(): Promise<void> {
    const paths = this.deployedPaths;
    if (!paths) return;
    logger.info(`ServerDeployer: stopping daemon at ${paths.binary}`);
    await this.run(`pkill -f ${shellQuote(paths.binary + ' ')} 2>/dev/null || true`);
    await this.run(`rm -f ${shellQuote(paths.socket)} ${shellQuote(paths.token)}`);
    this.deployedPaths = null;
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
 * Absolutise a remote path against the resolved `$HOME` of the remote.
 *
 * - Already-absolute paths (`/...`) pass through unchanged.
 * - `~` and `~/...` are expanded against `$HOME`.
 * - Bare relative paths are anchored at `$HOME`.
 *
 * Exported so it can be unit-tested without standing up a fake SSH
 * client.
 */
export function resolveRemotePath(p: string, remoteHome: string): string {
  const home = remoteHome.endsWith('/') ? remoteHome.slice(0, -1) : remoteHome;
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  if (p.startsWith('/')) return p;
  return `${home}/${p}`;
}

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
