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
   * State from the most recent successful `deploy()`, kept so `stop()`
   * can use the same kill pattern + cleanup paths the daemon was
   * actually started with.
   */
  private deployedState: {
    binary: string;
    socket: string;
    token: string;
    /**
     * Pre-built `pkill -f` regex (no leading anchor, trailing space)
     * that matches the daemon's argv regardless of whether it was
     * launched with the relative or the absolute form of the binary
     * path.
     */
    killPattern: string;
  } | null = null;

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
    const killPattern = buildKillPattern(remoteBinaryPath, home);

    logger.info(`ServerDeployer: ensuring ${remoteDir}/ exists`);
    await this.run(`mkdir -p ${shellQuote(remoteDir)} && chmod 700 ${shellQuote(remoteDir)}`);

    if (killExisting) {
      logger.info(`ServerDeployer: killing any prior daemon (pkill -f ${killPattern})`);
      // Use the suffix-form pattern so we catch daemons started by
      // older builds where the argv used the relative path. Without
      // this, an upgrade leaves the prior daemon alive and the upload
      // below hits ETXTBSY (text file busy) on Linux because the
      // binary it's overwriting is still being executed.
      await this.run(`pkill -f ${shellQuote(killPattern)} 2>/dev/null || true`);
      // Defense in depth: also unlink the binary itself. If pkill
      // missed (e.g., the prior daemon was started under a different
      // path shape we can't predict), Linux still lets us unlink an
      // executable that's running — the inode stays alive for the
      // existing process while the path is freed for our new file.
      await this.run(`rm -f ${shellQuote(remoteBinaryPath)} ${shellQuote(remoteSocketPath)} ${shellQuote(remoteTokenPath)}`);
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
    this.deployedState = {
      binary: remoteBinaryPath,
      socket: remoteSocketPath,
      token: remoteTokenPath,
      killPattern,
    };
    return { remoteBinaryPath, remoteSocketPath, remoteTokenPath, token };
  }

  /**
   * Stop the daemon launched by the most recent `deploy()`. Safe to
   * call when nothing was deployed (no-op). Uses the same suffix-form
   * pkill pattern deploy() chose, so a daemon stays killable even if
   * the running argv differs from the absolutised launch path.
   */
  async stop(): Promise<void> {
    const state = this.deployedState;
    if (!state) return;
    logger.info(`ServerDeployer: stopping daemon at ${state.binary}`);
    await this.run(`pkill -f ${shellQuote(state.killPattern)} 2>/dev/null || true`);
    await this.run(`rm -f ${shellQuote(state.binary)} ${shellQuote(state.socket)} ${shellQuote(state.token)}`);
    this.deployedState = null;
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
 * Build the regex `pkill -f` should match for a deployed daemon.
 *
 * The daemon's argv contains the binary path verbatim. Across versions
 * that path may be relative (`.obsidian-remote/server`) or absolute
 * (`$HOME/.obsidian-remote/server`); we want a single pattern that
 * matches both so an upgrade can clean up its predecessor.
 *
 * Strategy: take the absolute path and strip the `$HOME/` prefix,
 * yielding the segment that's guaranteed to appear in BOTH shapes.
 * Escape regex metacharacters so a literal `.obsidian-remote` doesn't
 * accidentally match `xobsidian-remote`. Append a trailing space so we
 * don't false-match on path prefixes (`.obsidian-remote/server-old`).
 *
 * For paths that don't live under `$HOME` (custom absolute), there's
 * no relative form to worry about — the absolute path itself becomes
 * the pattern.
 */
export function buildKillPattern(absoluteBinaryPath: string, remoteHome: string): string {
  const home = remoteHome.endsWith('/') ? remoteHome.slice(0, -1) : remoteHome;
  const tail = absoluteBinaryPath.startsWith(home + '/')
    ? absoluteBinaryPath.slice(home.length + 1)
    : absoluteBinaryPath;
  return escapeRegex(tail) + ' ';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
