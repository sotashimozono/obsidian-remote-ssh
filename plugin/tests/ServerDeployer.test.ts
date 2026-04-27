import { describe, it, expect } from 'vitest';
import { ServerDeployer, resolveRemotePath, type DeployerSshClient } from '../src/transport/ServerDeployer';

/**
 * Generic remote home used in mocks. Deliberately not the maintainer's
 * actual home (`/home/souta`) — the deployer must never assume any
 * particular shape, and tests should reflect that.
 */
const FAKE_HOME = '/home/alice';

/**
 * Recordable fake: exec commands queue up, uploadFile / readRemoteFile
 * call user-supplied scripts. Tests assert the order + content of the
 * commands that the deployer fires.
 */
function fakeSsh(opts: {
  /** Function called whenever the deployer reads a remote file (e.g. the token). */
  onReadFile: (path: string) => Buffer;
  /** Optional override for exec stdout/stderr/exit per command. */
  onExec?: (cmd: string) => { stdout?: string; stderr?: string; exitCode?: number };
  /** Override the remote $HOME exposed via getRemoteHome(). */
  remoteHome?: string;
}): {
  ssh: DeployerSshClient;
  execLog: string[];
  uploads: Array<{ local: string; remote: string }>;
  homeCalls: { count: number };
} {
  const execLog: string[] = [];
  const uploads: Array<{ local: string; remote: string }> = [];
  const homeCalls = { count: 0 };
  const home = opts.remoteHome ?? FAKE_HOME;

  const ssh: DeployerSshClient = {
    async exec(cmd) {
      execLog.push(cmd);
      const r = opts.onExec?.(cmd);
      return {
        stdout:   r?.stdout ?? '',
        stderr:   r?.stderr ?? '',
        exitCode: r?.exitCode ?? 0,
      };
    },
    async uploadFile(local, remote) {
      uploads.push({ local, remote });
    },
    async readRemoteFile(remotePath) {
      return opts.onReadFile(remotePath);
    },
    async getRemoteHome() {
      homeCalls.count += 1;
      return home;
    },
  };
  return { ssh, execLog, uploads, homeCalls };
}

describe('ServerDeployer', () => {
  it('runs mkdir → kill → upload → chmod → start → wait-for-token in order, with absolutised paths', async () => {
    const { ssh, execLog, uploads } = fakeSsh({
      onReadFile: () => Buffer.from('token-abc'),
    });
    const deployer = new ServerDeployer(ssh);
    const out = await deployer.deploy({
      localBinaryPath: '/local/server',
      remoteVaultRoot: '/srv/vault',
      waitForTokenTimeoutMs: 1000,
    });

    expect(out.token).toBe('token-abc');
    // DeployResult must surface absolute paths so the caller can hand
    // the socket path straight to `openssh_forwardOutStreamLocal`,
    // which sees no CWD on the sshd side.
    expect(out.remoteBinaryPath).toBe(`${FAKE_HOME}/.obsidian-remote/server`);
    expect(out.remoteSocketPath).toBe(`${FAKE_HOME}/.obsidian-remote/server.sock`);
    expect(out.remoteTokenPath).toBe(`${FAKE_HOME}/.obsidian-remote/token`);
    expect(uploads).toEqual([{ local: '/local/server', remote: `${FAKE_HOME}/.obsidian-remote/server` }]);

    // The first three commands must, in order, prep the dir, kill any
    // prior daemon, and remove stale socket / token files. All paths
    // are absolute now.
    expect(execLog[0]).toMatch(new RegExp(`mkdir -p '${FAKE_HOME}/\\.obsidian-remote'`));
    expect(execLog[1]).toMatch(new RegExp(`pkill -f '${FAKE_HOME}/\\.obsidian-remote/server '`));
    expect(execLog[2]).toMatch(new RegExp(`rm -f '${FAKE_HOME}/\\.obsidian-remote/server\\.sock' '${FAKE_HOME}/\\.obsidian-remote/token'`));

    // chmod and start come after the upload.
    expect(execLog[3]).toMatch(new RegExp(`chmod 700 '${FAKE_HOME}/\\.obsidian-remote/server'`));
    const startCmd = execLog[4];
    expect(startCmd).toMatch(new RegExp(`^nohup '${FAKE_HOME}/\\.obsidian-remote/server'`));
    expect(startCmd).toMatch(/--vault-root='\/srv\/vault'/);
    expect(startCmd).toMatch(new RegExp(`--socket='${FAKE_HOME}/\\.obsidian-remote/server\\.sock'`));
    expect(startCmd).toMatch(new RegExp(`--token-file='${FAKE_HOME}/\\.obsidian-remote/token'`));
    expect(startCmd).toMatch(/&$/);
  });

  it('skips the kill step when killExisting is false', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      killExisting: false, waitForTokenTimeoutMs: 100,
    });
    expect(execLog.some(c => c.includes('pkill'))).toBe(false);
    expect(execLog.some(c => c.includes('rm -f'))).toBe(false);
  });

  it('honours custom remote paths and absolutises relative ones against $HOME', async () => {
    const { ssh, execLog, uploads } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      remoteBinaryPath: 'tools/orsd/bin',
      remoteSocketPath: 'tools/orsd/sock',
      remoteTokenPath:  'tools/orsd/tok',
      waitForTokenTimeoutMs: 100,
    });
    expect(uploads[0].remote).toBe(`${FAKE_HOME}/tools/orsd/bin`);
    const start = execLog.find(c => c.startsWith('nohup'))!;
    expect(start).toMatch(new RegExp(`--socket='${FAKE_HOME}/tools/orsd/sock'`));
    expect(start).toMatch(new RegExp(`--token-file='${FAKE_HOME}/tools/orsd/tok'`));
  });

  it('passes through paths that are already absolute, even if they contain spaces', async () => {
    const { ssh, execLog, uploads } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x',
      remoteVaultRoot: '/has spaces/vault',
      remoteBinaryPath: '/with space/server',
      remoteSocketPath: '/with space/server.sock',
      remoteTokenPath:  '/with space/token',
      waitForTokenTimeoutMs: 100,
    });
    expect(uploads[0].remote).toBe('/with space/server');
    const start = execLog.find(c => c.startsWith('nohup'))!;
    // Single-quoted, so the shell sees it as one argv entry.
    expect(start).toMatch(/--vault-root='\/has spaces\/vault'/);
    expect(start).toMatch(/--socket='\/with space\/server\.sock'/);
  });

  it('expands ~/... paths against $HOME', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      remoteBinaryPath: '~/custom/server',
      remoteSocketPath: '~/custom/server.sock',
      waitForTokenTimeoutMs: 100,
    });
    const start = execLog.find(c => c.startsWith('nohup'))!;
    expect(start).toMatch(new RegExp(`^nohup '${FAKE_HOME}/custom/server'`));
    expect(start).toMatch(new RegExp(`--socket='${FAKE_HOME}/custom/server\\.sock'`));
  });

  it('throws InternalError-shaped error if a non-tolerant command exits non-zero', async () => {
    const { ssh } = fakeSsh({
      onReadFile: () => Buffer.from(''),
      onExec: (cmd) => cmd.includes('mkdir') ? { exitCode: 5, stderr: 'permission denied' } : { exitCode: 0 },
    });
    await expect(new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    })).rejects.toThrow(/exited 5/);
  });

  it('retries token reads until the daemon writes one, then returns it', async () => {
    let calls = 0;
    const { ssh } = fakeSsh({
      onReadFile: () => {
        calls += 1;
        if (calls < 3) throw new Error('ENOENT');
        return Buffer.from('eventually-arrived');
      },
    });
    const out = await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 5000,
    });
    expect(out.token).toBe('eventually-arrived');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('throws after the token-wait deadline if the daemon never came up', async () => {
    const { ssh } = fakeSsh({
      onReadFile: () => { throw new Error('ENOENT'); },
    });
    await expect(new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 200,
    })).rejects.toThrow(/did not write/);
  });

  it('stop() targets the absolute paths from the most recent deploy()', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    const deployer = new ServerDeployer(ssh);
    await deployer.deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    });
    const before = execLog.length;
    await deployer.stop();
    const stopCmds = execLog.slice(before);
    expect(stopCmds.length).toBe(2);
    expect(stopCmds[0]).toMatch(new RegExp(`pkill -f '${FAKE_HOME}/\\.obsidian-remote/server '`));
    expect(stopCmds[1]).toMatch(new RegExp(`rm -f '${FAKE_HOME}/\\.obsidian-remote/server\\.sock' '${FAKE_HOME}/\\.obsidian-remote/token'`));
  });

  it('stop() is a no-op if deploy() never ran', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('') });
    await new ServerDeployer(ssh).stop();
    expect(execLog.length).toBe(0);
  });

  it('caches getRemoteHome across mkdir/start/etc within one deploy()', async () => {
    const { ssh, homeCalls } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    });
    // The deployer should query $HOME exactly once, even though four
    // separate paths get resolved.
    expect(homeCalls.count).toBe(1);
  });
});

describe('resolveRemotePath', () => {
  it('passes absolute paths through unchanged', () => {
    expect(resolveRemotePath('/etc/foo', '/home/alice')).toBe('/etc/foo');
    expect(resolveRemotePath('/', '/home/alice')).toBe('/');
  });

  it('expands ~ to $HOME', () => {
    expect(resolveRemotePath('~', '/home/alice')).toBe('/home/alice');
  });

  it('expands ~/foo to $HOME/foo', () => {
    expect(resolveRemotePath('~/foo/bar', '/home/alice')).toBe('/home/alice/foo/bar');
  });

  it('anchors bare relative paths at $HOME', () => {
    expect(resolveRemotePath('foo/bar', '/home/alice')).toBe('/home/alice/foo/bar');
    expect(resolveRemotePath('.obsidian-remote/server.sock', '/home/alice'))
      .toBe('/home/alice/.obsidian-remote/server.sock');
  });

  it('handles $HOME with a trailing slash', () => {
    expect(resolveRemotePath('foo', '/home/alice/')).toBe('/home/alice/foo');
    expect(resolveRemotePath('~/foo', '/home/alice/')).toBe('/home/alice/foo');
    expect(resolveRemotePath('~', '/home/alice/')).toBe('/home/alice');
  });

  it('does not assume a /home/... shape', () => {
    // macOS-style, container-style, root user — all valid.
    expect(resolveRemotePath('foo', '/Users/alice')).toBe('/Users/alice/foo');
    expect(resolveRemotePath('foo', '/var/lib/runner')).toBe('/var/lib/runner/foo');
    expect(resolveRemotePath('foo', '/root')).toBe('/root/foo');
  });
});
