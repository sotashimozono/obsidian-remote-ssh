import { Client } from 'ssh2';
import type { ConnectConfig, KeyboardInteractiveCallback, Prompt, SFTPWrapper, Stats } from 'ssh2';
import type { Duplex } from 'stream';
import type { RemoteEntry, RemoteStat, SshProfile } from '../types';
import { TMP_SUFFIX } from '../constants';
import { AuthResolver } from './AuthResolver';
import { HostKeyStore, type HostKeyMismatchHandler } from './HostKeyStore';
import { createJumpTunnel } from './JumpHostTunnel';
import { logger } from '../util/logger';
import { asError, errorMessage } from '../util/errorMessage';

export type CloseListener = (info: { unexpected: boolean }) => void;

/**
 * Async callback invoked when the SSH server asks for a
 * `keyboard-interactive` round (TOTP / RSA SecurID / PAM PIN, etc.).
 * Receives the server's per-prompt challenge list and resolves with
 * one response per prompt in the same order. Returning `null` is
 * treated as cancel — `SftpClient` forwards `[]` to ssh2's `finish`
 * callback, which fails the auth round cleanly.
 *
 * Wired only by the plugin's UI layer (`main.ts` constructs the
 * callback as `prompts => new KbdInteractiveModal(app, prompts).prompt()`).
 * Integration tests and the rest of the codebase that doesn't need
 * an interactive prompt simply pass nothing — `tryKeyboard` stays
 * off and ssh2 behaves exactly as before.
 */
export type KbdInteractiveHandlerFn = (
  prompts: Array<{ prompt: string; echo: boolean }>,
) => Promise<string[] | null>;

/**
 * String encoding accepted by Buffer / NodeJS.Buffer's `toString` /
 * `Buffer.from(..., enc)`. Re-declared here as a local alias so this
 * file does not depend on the ambient `BufferEncoding` global from
 * `@types/node`, which trips ESLint's `no-undef` in the ObsidianReviewBot
 * environment.
 */
type SftpEncoding =
  | 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'utf-16le'
  | 'ucs2' | 'ucs-2' | 'base64' | 'base64url' | 'latin1'
  | 'binary' | 'hex';


export interface RemoteEntryWithRel extends RemoteEntry {
  /** Path relative to the listRecursive root (no leading slash). */
  relativePath: string;
}

/**
 * Single-connection SFTP wrapper used by the data adapter and by
 * higher-level features (watch poller, resource bridge). Atomic writes
 * are implemented via tmp+rename. The OpenSSH posix-rename extension is
 * preferred when the server advertises it.
 */
/**
 * Wire a keyboard-interactive handler onto an EventEmitter-shaped client.
 * Extracted from `SftpClient.connect` so the normalisation, forwarding,
 * and error-recovery logic can be unit-tested without a real ssh2 Client.
 *
 * @internal Exported for testing only.
 */
export function wireKeyboardInteractiveHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ssh2 Client.on uses `any[]` in its listener signature; narrowing to `unknown[]` breaks assignability
  client: { on(event: string, listener: (...args: any[]) => void): void },
  handler: KbdInteractiveHandlerFn,
): void {
  client.on('keyboard-interactive', (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Prompt[],
    finish: KeyboardInteractiveCallback,
  ) => {
    const normalised = prompts.map(p => ({
      prompt: p.prompt,
      echo:   p.echo ?? false,
    }));
    handler(normalised).then(
      (responses) => {
        finish(responses ?? []);
      },
      (err: unknown) => {
        logger.warn(
          `SftpClient: keyboard-interactive handler threw: ${errorMessage(err)}; failing auth`,
        );
        finish([]);
      },
    );
  });
}

export class SftpClient {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private profile: SshProfile | null = null;
  private closeListeners: CloseListener[] = [];
  private intentionalDisconnect = false;
  private remoteHome: string | null = null;

  constructor(
    private authResolver: AuthResolver,
    private hostKeyStore: HostKeyStore,
    /**
     * Optional. When supplied, `connect()` enables ssh2's
     * `tryKeyboard` and forwards keyboard-interactive challenges to
     * this callback (typically a Modal in the UI). Omitted by the
     * integration test fixtures and any non-UI caller, so existing
     * 2-arg constructions stay valid.
     */
    private kbdInteractiveHandler?: KbdInteractiveHandlerFn,
    /**
     * Optional. When supplied, `connect()` uses ssh2's async
     * `HostVerifier` overload and forwards a fingerprint mismatch to
     * this callback so the user can choose to trust the new key (=
     * `'trust'` → forget old + re-pin via TOFU) or refuse the
     * handshake (= `'abort'` → connect rejects). Omitted by tests
     * and non-UI callers, in which case mismatch falls back to the
     * existing fail-closed sync `verify()` path.
     */
    private hostKeyMismatchHandler?: HostKeyMismatchHandler,
  ) {}

  // ─── lifecycle ───────────────────────────────────────────────────────────

  isAlive(): boolean {
    return this.client !== null && this.sftp !== null;
  }

  getProfile(): SshProfile | null {
    return this.profile;
  }

  onClose(cb: CloseListener): () => void {
    this.closeListeners.push(cb);
    return () => { this.closeListeners = this.closeListeners.filter(l => l !== cb); };
  }

  async connect(profile: SshProfile): Promise<void> {
    if (this.isAlive()) {
      throw new Error('SftpClient: already connected (call disconnect first)');
    }
    this.profile = profile;
    this.intentionalDisconnect = false;

    logger.info(`SftpClient: connecting to ${profile.host}:${profile.port} as ${profile.username}`);

    const authConfig = this.authResolver.buildAuthConfig(profile);
    let sock: Duplex | undefined;
    if (profile.jumpHost) {
      logger.info(`SftpClient: opening jump tunnel via ${profile.jumpHost.host}`);
      // Share the host-key store + connect timings between the jump
      // and target so a compromised bastion is caught the same way
      // as a compromised target, and the jump session tears down
      // around the same time the target idle-keepalive does.
      sock = await createJumpTunnel(
        profile.jumpHost,
        profile.host,
        profile.port,
        this.authResolver,
        {
          hostKeyStore:           this.hostKeyStore,
          // Pass the same mismatch handler we use for the target
          // host so a jump-host fingerprint change also surfaces the
          // recovery modal instead of failing with a generic "Jump
          // host connect failed" error (#132 follow-up).
          hostKeyMismatchHandler: this.hostKeyMismatchHandler,
          connectTimeoutMs:       profile.connectTimeoutMs,
          keepaliveIntervalMs:    profile.keepaliveIntervalMs,
        },
      );
    }

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      // Use Obsidian's `activeWindow` timers as required by
      // `obsidianmd/prefer-active-window-timers`. The vitest setup
      // polyfill aliases `activeWindow` to `globalThis` so the same
      // call works under Node-style integration tests.
      const timer = activeWindow.setTimeout(() => {
        client.destroy();
        reject(new Error(`Connection timed out after ${profile.connectTimeoutMs}ms`));
      }, profile.connectTimeoutMs);

      client.on('ready', () => {
        activeWindow.clearTimeout(timer);
        logger.info(`SftpClient: SSH ready (${profile.host})`);
        resolve();
      });

      client.on('error', err => {
        activeWindow.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      client.on('close', () => {
        const wasAlive = this.client === client;
        this.client = null;
        this.sftp = null;
        this.remoteHome = null;
        if (wasAlive) {
          logger.warn(`SftpClient: connection closed (${profile.host})`);
          const unexpected = !this.intentionalDisconnect;
          for (const cb of [...this.closeListeners]) {
            try { cb({ unexpected }); } catch (e) { logger.warn(`onClose listener threw: ${errorMessage(e)}`); }
          }
        }
      });

      // keyboard-interactive (TOTP / SecurID / Duo Push / PAM PIN).
      // ssh2 only fires this event when `tryKeyboard: true` is in the
      // config AND the server actively asks for it; absence of a
      // handler means we leave the flag off entirely so the previous
      // pubkey/agent/password-only behaviour is preserved bit-for-bit.
      if (this.kbdInteractiveHandler) {
        wireKeyboardInteractiveHandler(client, this.kbdInteractiveHandler);
      }

      // hostVerifier shape switches based on whether a mismatch
      // handler was wired. ssh2's async overload `(key, verify) =>
      // void` lets us await the user's modal choice inside the
      // handshake; without a handler we keep the synchronous boolean
      // overload so tests / non-UI callers retain the exact previous
      // behaviour (fail-closed on mismatch, no async surface).
      const hostVerifier = this.hostKeyMismatchHandler
        ? (key: Buffer, verify: (valid: boolean) => void): void => {
            const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
            this.hostKeyStore.verifyAsync(
              profile.host,
              profile.port,
              keyBuf,
              this.hostKeyMismatchHandler,
            ).then(verify, (e: unknown) => {
              // verifyAsync already swallows handler errors; this
              // is a defence-in-depth path for impossible failures.
              logger.warn(
                `SftpClient: hostVerifier rejected unexpectedly for ` +
                `${profile.host}:${profile.port}: ${errorMessage(e)}`,
              );
              verify(false);
            });
          }
        : (key: Buffer | string): boolean => {
            const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
            return this.hostKeyStore.verify(profile.host, profile.port, keyBuf);
          };

      const config: ConnectConfig = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        keepaliveInterval: profile.keepaliveIntervalMs,
        keepaliveCountMax: profile.keepaliveCountMax,
        readyTimeout: profile.connectTimeoutMs,
        hostVerifier,
        // Only flip tryKeyboard on when a handler exists. The flag's
        // presence makes ssh2 advertise keyboard-interactive in the
        // method list it offers the server — leaving it off when no
        // handler is wired keeps integration tests deterministic
        // (some test sshd images would otherwise prompt).
        ...(this.kbdInteractiveHandler ? { tryKeyboard: true } : {}),
        ...(sock ? { sock } : {}),
        ...authConfig,
      };

      client.connect(config);
    });

    this.client = client;
    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => err ? reject(asError(err)) : resolve(sftp));
    });
    logger.info(`SftpClient: SFTP channel open`);
  }

  /**
   * Forward a local Duplex to a unix-domain socket on the remote host.
   *
   * Used by the α transport to reach `obsidian-remote-server`'s
   * listening socket (e.g. `~/.obsidian-remote/server.sock`) through
   * the same SSH connection that already carries the SFTP channel.
   * Requires OpenSSH's `direct-streamlocal@openssh.com` extension,
   * which every mainstream sshd has shipped since OpenSSH 6.7.
   */
  async openUnixStream(socketPath: string): Promise<Duplex> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      client.openssh_forwardOutStreamLocal(socketPath, (err: Error | undefined, stream: Duplex) => {
        if (err) reject(asError(err));
        else resolve(stream);
      });
    });
  }

  /**
   * Read a small file off the remote via SFTP. Intended for reading
   * one-shot state like the daemon's session token; for vault files
   * use `readBinary`/`readText` which go through the same channel
   * but return typed buffers directly.
   */
  async readRemoteFile(remotePath: string): Promise<Buffer> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err, buf) => err ? reject(asError(err)) : resolve(buf));
    });
  }

  /**
   * Upload a local file to the remote via SFTP, like scp. Used by the
   * auto-deploy flow to ship `obsidian-remote-server` on connect. The
   * destination directory must already exist; create it via `exec`
   * first if you can't be sure.
   */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, { concurrency: 4 }, err => err ? reject(asError(err)) : resolve());
    });
  }

  /**
   * Run a one-shot command on the remote and collect its stdout, stderr,
   * and exit code. Long-running streams (interactive shells, the daemon
   * process itself) should not go through here — they'd never close.
   */
  async exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) { reject(asError(err)); return; }
        let stdout = '';
        let stderr = '';
        let exitCode = -1;
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        stream.on('exit', (code: number) => { exitCode = code; });
        stream.on('close', () => resolve({ stdout, stderr, exitCode }));
        stream.on('error', (e: Error) => reject(asError(e)));
      });
    });
  }

  disconnect(): Promise<void> {
    // Synchronous teardown wrapped in a resolved Promise so the public
    // API (which callers `await`) stays Promise-typed without forcing
    // a no-op `await` (rejected by `require-await`).
    this.intentionalDisconnect = true;
    const client = this.client;
    this.client = null;
    this.sftp = null;
    this.profile = null;
    this.remoteHome = null;
    if (client) {
      try { client.end(); } catch (e) { logger.warn(`SftpClient.disconnect: ${errorMessage(e)}`); }
    }
    return Promise.resolve();
  }

  /**
   * Resolve and cache the remote `$HOME` for the active connection.
   *
   * Needed because OpenSSH unix-socket forwarding (direct-streamlocal)
   * does not chdir on the sshd side: a relative socket path passed to
   * `openssh_forwardOutStreamLocal` is resolved against `/`, not the
   * user's home, so callers that want "home-relative" paths must
   * absolutise them client-side.
   *
   * The shape of `$HOME` is environment-dependent (`/home/<user>`,
   * `/Users/<user>`, custom container paths, shell-overridden, etc.) —
   * never assume; always ask the actual remote.
   */
  async getRemoteHome(): Promise<string> {
    if (this.remoteHome) return this.remoteHome;
    const r = await this.exec('echo "$HOME"');
    if (r.exitCode !== 0) {
      throw new Error(
        `SftpClient.getRemoteHome: echo $HOME exited ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}`,
      );
    }
    const home = r.stdout.trim();
    if (!home) {
      throw new Error('SftpClient.getRemoteHome: $HOME is empty on remote');
    }
    this.remoteHome = home;
    return home;
  }

  // ─── read-side ───────────────────────────────────────────────────────────

  async stat(remotePath: string): Promise<RemoteStat> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) reject(asError(err));
        else resolve(toRemoteStat(stats));
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(remotePath: string): Promise<RemoteEntry[]> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          reject(asError(err));
          return;
        }
        const out: RemoteEntry[] = [];
        for (const e of list as ReadonlyArray<{ filename: string; attrs: Stats }>) {
          if (e.filename === '.' || e.filename === '..') continue;
          out.push(toRemoteEntryFromStats(e.filename, e.attrs));
        }
        resolve(out);
      });
    });
  }

  async listRecursive(
    rootPath: string,
    filter?: (relativePath: string) => boolean,
  ): Promise<RemoteEntryWithRel[]> {
    const out: RemoteEntryWithRel[] = [];
    const queue: string[] = [rootPath];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: RemoteEntry[];
      try {
        entries = await this.list(dir);
      } catch (e) {
        logger.warn(`listRecursive: cannot readdir "${dir}": ${errorMessage(e)}`);
        continue;
      }
      for (const entry of entries) {
        const full = `${dir}/${entry.name}`;
        const rel = full.slice(rootPath.length + 1);
        if (filter && !filter(rel)) continue;
        out.push({ ...entry, relativePath: rel });
        if (entry.isDirectory && !visited.has(full)) {
          visited.add(full);
          queue.push(full);
        }
      }
    }
    return out;
  }

  async readBinary(remotePath: string): Promise<Buffer> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err, buf) => err ? reject(asError(err)) : resolve(buf));
    });
  }

  async readText(remotePath: string, encoding: SftpEncoding = 'utf8'): Promise<string> {
    const buf = await this.readBinary(remotePath);
    return buf.toString(encoding);
  }

  // ─── write-side ──────────────────────────────────────────────────────────

  async writeBinary(remotePath: string, data: Buffer): Promise<void> {
    return this.atomicWrite(remotePath, data);
  }

  async writeText(remotePath: string, data: string, encoding: SftpEncoding = 'utf8'): Promise<void> {
    return this.atomicWrite(remotePath, Buffer.from(data, encoding));
  }

  /** Best-effort overwrite via tmp file + atomic rename. Cleans up tmp on failure. */
  private async atomicWrite(remotePath: string, data: Buffer): Promise<void> {
    const sftp = this.requireSftp();
    const tmpPath = remotePath + TMP_SUFFIX;
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(tmpPath, data, err => err ? reject(asError(err)) : resolve());
      });
      await this.rename(tmpPath, remotePath);
    } catch (e) {
      try { await this.remove(tmpPath); } catch { /* ignore cleanup failure */ }
      throw e;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      const sftpAny = sftp as unknown as {
        _extensions?: Record<string, unknown>;
        ext_openssh_rename?: (src: string, dst: string, cb: (err: Error | undefined) => void) => void;
      };
      if (sftpAny._extensions && sftpAny._extensions['posix-rename@openssh.com'] && sftpAny.ext_openssh_rename) {
        sftpAny.ext_openssh_rename(oldPath, newPath, err => err ? reject(asError(err)) : resolve());
      } else {
        sftp.rename(oldPath, newPath, err => err ? reject(asError(err)) : resolve());
      }
    });
  }

  async copy(srcPath: string, destPath: string): Promise<void> {
    // SFTP has no native copy; round-trip via memory.
    const data = await this.readBinary(srcPath);
    await this.writeBinary(destPath, data);
  }

  async remove(remotePath: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, err => err ? reject(asError(err)) : resolve());
    });
  }

  /**
   * Create the directory, treating "already exists" as success.
   *
   * OpenSSH's SFTP server reports an existing directory as
   * SSH_FX_FAILURE with the opaque message "Failure", so a substring
   * match on "exist" misses it. Stat-then-mkdir avoids the ambiguity:
   * if a directory is already there we are done; if a non-directory
   * is in the way we surface the conflict; otherwise we mkdir and let
   * a real SFTP error bubble up.
   */
  async mkdir(remotePath: string): Promise<void> {
    const sftp = this.requireSftp();
    try {
      const s = await this.stat(remotePath);
      if (s.isDirectory) return;
      throw new Error(`mkdir: "${remotePath}" exists and is not a directory`);
    } catch (e) {
      // Treat any stat failure as "path is not there yet" and try to create it.
      if (errorMessage(e)?.startsWith('mkdir: ')) throw e;
    }
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, err => {
        if (err && !err.message.toLowerCase().includes('exist')) reject(asError(err));
        else resolve();
      });
    });
  }

  async mkdirp(remotePath: string): Promise<void> {
    const isAbs = remotePath.startsWith('/');
    const parts = remotePath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = isAbs
        ? current + '/' + part
        : (current ? current + '/' + part : part);
      await this.mkdir(current);
    }
  }

  async rmdir(remotePath: string, recursive = false): Promise<void> {
    const sftp = this.requireSftp();
    if (recursive) {
      const entries = await this.listRecursive(remotePath);
      const depth = (p: string) => p.split('/').length;
      const files = entries.filter(e => !e.isDirectory);
      const dirs = entries.filter(e => e.isDirectory).sort((a, b) => depth(b.relativePath) - depth(a.relativePath));
      for (const f of files) {
        await this.remove(`${remotePath}/${f.relativePath}`);
      }
      for (const d of dirs) {
        await new Promise<void>((resolve, reject) => {
          sftp.rmdir(`${remotePath}/${d.relativePath}`, err => err ? reject(asError(err)) : resolve());
        });
      }
    }
    return new Promise((resolve, reject) => {
      sftp.rmdir(remotePath, err => err ? reject(asError(err)) : resolve());
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) throw new Error('SftpClient: not connected');
    return this.sftp;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('SftpClient: not connected');
    return this.client;
  }
}

function toRemoteStat(stats: Stats): RemoteStat {
  return {
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
    mtime: stats.mtime * 1000,
    size: stats.size,
    mode: stats.mode,
  };
}

function toRemoteEntryFromStats(name: string, stats: Stats): RemoteEntry {
  return {
    name,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
    mtime: stats.mtime * 1000,
    size: stats.size,
  };
}
