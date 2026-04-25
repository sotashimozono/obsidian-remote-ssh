import { describe, it, expect } from 'vitest';
import { ServerDeployer, type DeployerSshClient } from '../src/transport/ServerDeployer';

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
}): {
  ssh: DeployerSshClient;
  execLog: string[];
  uploads: Array<{ local: string; remote: string }>;
} {
  const execLog: string[] = [];
  const uploads: Array<{ local: string; remote: string }> = [];

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
  };
  return { ssh, execLog, uploads };
}

describe('ServerDeployer', () => {
  it('runs mkdir → kill → upload → chmod → start → wait-for-token in order', async () => {
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
    expect(uploads).toEqual([{ local: '/local/server', remote: '.obsidian-remote/server' }]);

    // The first three commands must, in order, prep the dir, kill any
    // prior daemon, and remove stale socket / token files.
    expect(execLog[0]).toMatch(/mkdir -p '\.obsidian-remote'/);
    expect(execLog[1]).toMatch(/pkill -f '\.obsidian-remote\/server '/);
    expect(execLog[2]).toMatch(/rm -f '\.obsidian-remote\/server\.sock' '\.obsidian-remote\/token'/);

    // chmod and start come after the upload.
    expect(execLog[3]).toMatch(/chmod 700 '\.obsidian-remote\/server'/);
    const startCmd = execLog[4];
    expect(startCmd).toMatch(/^nohup '\.obsidian-remote\/server'/);
    expect(startCmd).toMatch(/--vault-root='\/srv\/vault'/);
    expect(startCmd).toMatch(/--socket='\.obsidian-remote\/server\.sock'/);
    expect(startCmd).toMatch(/--token-file='\.obsidian-remote\/token'/);
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

  it('honours custom remote paths', async () => {
    const { ssh, execLog, uploads } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x', remoteVaultRoot: '/y',
      remoteBinaryPath: 'tools/orsd/bin',
      remoteSocketPath: 'tools/orsd/sock',
      remoteTokenPath:  'tools/orsd/tok',
      waitForTokenTimeoutMs: 100,
    });
    expect(uploads[0].remote).toBe('tools/orsd/bin');
    const start = execLog.find(c => c.startsWith('nohup'))!;
    expect(start).toMatch(/--socket='tools\/orsd\/sock'/);
    expect(start).toMatch(/--token-file='tools\/orsd\/tok'/);
  });

  it('quotes paths that contain spaces', async () => {
    const { ssh, execLog, uploads } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: '/x',
      remoteVaultRoot: '/has spaces/vault',
      remoteBinaryPath: '/with space/server',
      waitForTokenTimeoutMs: 100,
    });
    expect(uploads[0].remote).toBe('/with space/server');
    const start = execLog.find(c => c.startsWith('nohup'))!;
    // Single-quoted, so the shell sees it as one argv entry.
    expect(start).toMatch(/--vault-root='\/has spaces\/vault'/);
    expect(start).toMatch(/--socket='\.obsidian-remote\/server\.sock'/);
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

  it('stop() kills the daemon and cleans up socket + token', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('') });
    await new ServerDeployer(ssh).stop();
    expect(execLog.length).toBe(2);
    expect(execLog[0]).toMatch(/pkill -f '\.obsidian-remote\/server '/);
    expect(execLog[1]).toMatch(/rm -f '\.obsidian-remote\/server\.sock' '\.obsidian-remote\/token'/);
  });
});
