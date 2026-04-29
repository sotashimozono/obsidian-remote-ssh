import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ServerDeployer, resolveRemotePath, buildKillPattern, computeFileSha256, type DeployerSshClient } from '../src/transport/ServerDeployer';

/**
 * Generic remote home used in mocks. Deliberately a fake path — the
 * deployer must never assume any particular shape (`/home/...`,
 * `/Users/...`, container paths) and tests should reflect that.
 */
const FAKE_HOME = '/home/alice';

/**
 * Real on-disk binary fixture for `localBinaryPath`. Phase D-δ / F23
 * added a sha256 verification step that hashes the local file via
 * `fs.createReadStream`, so a non-existent dummy path no longer
 * works. Created once per suite and cleaned up in afterAll.
 */
let BIN: { path: string; sha256: string };
let BIN_DIR: string;

beforeAll(() => {
  BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-deploy-test-'));
  const p = path.join(BIN_DIR, 'fake-server-binary');
  const data = Buffer.from('fake binary contents — would normally be a few MB Go ELF');
  fs.writeFileSync(p, data);
  BIN = { path: p, sha256: crypto.createHash('sha256').update(data).digest('hex') };
});

afterAll(() => {
  try { fs.rmSync(BIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Recordable fake: exec commands queue up, uploadFile / readRemoteFile
 * call user-supplied scripts. Tests assert the order + content of the
 * commands that the deployer fires.
 *
 * Default-responds to `sha256sum` commands with the matching hex of
 * the BIN fixture so the deployer's verify step (Phase D-δ / F23)
 * succeeds without each test having to wire it explicitly.
 */
function fakeSsh(opts: {
  /** Function called whenever the deployer reads a remote file (e.g. the token). */
  onReadFile: (path: string) => Buffer;
  /** Optional override for exec stdout/stderr/exit per command. */
  onExec?: (cmd: string) => { stdout?: string; stderr?: string; exitCode?: number };
  /** Override the remote $HOME exposed via getRemoteHome(). */
  remoteHome?: string;
  /** Override the sha256 the fake `sha256sum` returns (for tampering tests). */
  shaResponse?: string;
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
      // Default sha256sum response → BIN.sha256 (verify passes). Tests
      // can override via opts.onExec (returned earlier wins) or via
      // opts.shaResponse to inject a mismatch.
      if (cmd.startsWith('sha256sum') && !opts.onExec?.(cmd)) {
        return { stdout: `${opts.shaResponse ?? BIN.sha256}  /remote/path\n`, stderr: '', exitCode: 0 };
      }
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
      localBinaryPath: BIN.path,
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
    expect(uploads).toEqual([{ local: BIN.path, remote: `${FAKE_HOME}/.obsidian-remote/server` }]);

    // The first three commands must, in order, prep the dir, kill any
    // prior daemon, and remove stale binary + socket + token files.
    expect(execLog[0]).toMatch(new RegExp(`mkdir -p '${FAKE_HOME}/\\.obsidian-remote'`));
    // pkill uses the suffix-form pattern (no $HOME prefix) so it
    // matches daemons started with either the relative or absolute
    // argv shape.
    expect(execLog[1]).toBe(`pkill -f '\\.obsidian-remote/server ' 2>/dev/null || true`);
    // rm includes the binary itself so a stale daemon's hold on the
    // file (ETXTBSY) can't block the upcoming upload.
    expect(execLog[2]).toBe(`rm -f '${FAKE_HOME}/.obsidian-remote/server' '${FAKE_HOME}/.obsidian-remote/server.sock' '${FAKE_HOME}/.obsidian-remote/token'`);

    // chmod, sha256sum verify, and start come after the upload.
    // Phase D-δ / F23 added the sha256sum step between chmod and the
    // nohup launch — the daemon never starts unless the bytes on
    // disk match what we shipped.
    expect(execLog[3]).toMatch(new RegExp(`chmod 700 '${FAKE_HOME}/\\.obsidian-remote/server'`));
    expect(execLog[4]).toMatch(new RegExp(`^sha256sum '${FAKE_HOME}/\\.obsidian-remote/server'`));
    const startCmd = execLog[5];
    expect(startCmd).toMatch(new RegExp(`^nohup '${FAKE_HOME}/\\.obsidian-remote/server'`));
    expect(startCmd).toMatch(/--vault-root='\/srv\/vault'/);
    expect(startCmd).toMatch(new RegExp(`--socket='${FAKE_HOME}/\\.obsidian-remote/server\\.sock'`));
    expect(startCmd).toMatch(new RegExp(`--token-file='${FAKE_HOME}/\\.obsidian-remote/token'`));
    expect(startCmd).toMatch(/&$/);
  });

  it('skips the kill step when killExisting is false', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      killExisting: false, waitForTokenTimeoutMs: 100,
    });
    expect(execLog.some(c => c.includes('pkill'))).toBe(false);
    expect(execLog.some(c => c.includes('rm -f'))).toBe(false);
  });

  it('honours custom remote paths and absolutises relative ones against $HOME', async () => {
    const { ssh, execLog, uploads } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
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
      localBinaryPath: BIN.path,
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
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
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
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
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
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
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
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 200,
    })).rejects.toThrow(/did not write/);
  });

  it('stop() reuses the deploy()-time kill pattern and cleans up binary + socket + token', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    const deployer = new ServerDeployer(ssh);
    await deployer.deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    });
    const before = execLog.length;
    await deployer.stop();
    const stopCmds = execLog.slice(before);
    expect(stopCmds.length).toBe(2);
    // Suffix pattern, same shape as deploy() uses, so it stays
    // effective against pre-fix daemons.
    expect(stopCmds[0]).toBe(`pkill -f '\\.obsidian-remote/server ' 2>/dev/null || true`);
    expect(stopCmds[1]).toBe(`rm -f '${FAKE_HOME}/.obsidian-remote/server' '${FAKE_HOME}/.obsidian-remote/server.sock' '${FAKE_HOME}/.obsidian-remote/token'`);
  });

  it('stop() is a no-op if deploy() never ran', async () => {
    const { ssh, execLog } = fakeSsh({ onReadFile: () => Buffer.from('') });
    await new ServerDeployer(ssh).stop();
    expect(execLog.length).toBe(0);
  });

  it('caches getRemoteHome across mkdir/start/etc within one deploy()', async () => {
    const { ssh, homeCalls } = fakeSsh({ onReadFile: () => Buffer.from('tok') });
    await new ServerDeployer(ssh).deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    });
    // The deployer should query $HOME exactly once, even though four
    // separate paths get resolved.
    expect(homeCalls.count).toBe(1);
  });

  // ── Phase D-δ / F23: sha256 verification ────────────────────────────

  it('F23: rejects deploy when remote sha256 does NOT match local — no daemon launch', async () => {
    const { ssh, execLog } = fakeSsh({
      onReadFile: () => Buffer.from('tok'),
      // Remote returns a different sha — simulates corrupted upload
      // OR a malicious host swap between SFTP-write and our exec.
      shaResponse: '0000000000000000000000000000000000000000000000000000000000000000',
    });
    await expect(new ServerDeployer(ssh).deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    })).rejects.toThrow(/binary verification failed/);
    // The nohup never fires — verify that the launch step is absent.
    // pkill / rm / mkdir / chmod / sha256sum may all be present, but
    // not nohup (the deploy aborted at the verify check).
    expect(execLog.some(c => c.startsWith('nohup'))).toBe(false);
  });

  it('F23: rejects deploy when remote sha256sum errors out (sha256sum missing on host)', async () => {
    const { ssh } = fakeSsh({
      onReadFile: () => Buffer.from('tok'),
      onExec: (cmd) => cmd.startsWith('sha256sum')
        ? { exitCode: 127, stderr: 'sha256sum: command not found' }
        : { exitCode: 0 },
    });
    await expect(new ServerDeployer(ssh).deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    })).rejects.toThrow(/exited 127/);
  });

  it('F23: extracts the leading hex from sha256sum\'s `<hex>  <path>` output', async () => {
    // sha256sum's output format is `<sha-hex>  <path>\n`. The verify
    // path must split on whitespace and take only the leading hex,
    // so an unusual remote path doesn't trip parsing.
    const { ssh } = fakeSsh({
      onReadFile: () => Buffer.from('tok'),
      onExec: (cmd) => cmd.startsWith('sha256sum')
        ? { stdout: `${BIN.sha256}  /weird/path with spaces/server\n`, exitCode: 0 }
        : { exitCode: 0 },
    });
    // Should NOT throw — parsing handles the weird trailing path.
    const out = await new ServerDeployer(ssh).deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    });
    expect(out.token).toBe('tok');
  });

  it('F23: tolerates uppercase / whitespace differences in the remote sha (case-insensitive)', async () => {
    // Some sha256sum implementations emit upper-case hex; the verify
    // step lowercases before comparing.
    const { ssh } = fakeSsh({
      onReadFile: () => Buffer.from('tok'),
      onExec: (cmd) => cmd.startsWith('sha256sum')
        ? { stdout: `   ${BIN.sha256.toUpperCase()}  /remote\n`, exitCode: 0 }
        : { exitCode: 0 },
    });
    const out = await new ServerDeployer(ssh).deploy({
      localBinaryPath: BIN.path, remoteVaultRoot: '/y',
      waitForTokenTimeoutMs: 100,
    });
    expect(out.token).toBe('tok');
  });
});

describe('computeFileSha256', () => {
  it('produces the same digest crypto.createHash gives for the same bytes', async () => {
    const got = await computeFileSha256(BIN.path);
    expect(got).toBe(BIN.sha256);
    // Lowercase hex, fixed 64 chars (sha-256 = 32 bytes = 64 hex).
    expect(got).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects with the underlying ENOENT when the file does not exist', async () => {
    await expect(computeFileSha256('/no/such/file.bin')).rejects.toThrow(/ENOENT/);
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

describe('buildKillPattern', () => {
  it('strips $HOME prefix so the pattern matches both relative and absolute argv', () => {
    const pattern = buildKillPattern('/home/alice/.obsidian-remote/server', '/home/alice');
    // Suffix only, escaped, trailing space.
    expect(pattern).toBe('\\.obsidian-remote/server ');

    // Same regex must match both shapes a real daemon argv could take.
    const re = new RegExp(pattern);
    expect(re.test('.obsidian-remote/server --vault-root=work/v --socket=...')).toBe(true);
    expect(re.test('/home/alice/.obsidian-remote/server --vault-root=work/v --socket=...')).toBe(true);
  });

  it('escapes regex metacharacters so a literal . does not match unrelated paths', () => {
    const pattern = buildKillPattern('/home/alice/.obsidian-remote/server', '/home/alice');
    const re = new RegExp(pattern);
    // The leading `.` is regex-escaped, so this typo-style argv must
    // NOT match.
    expect(re.test('xobsidian-remote/server --foo')).toBe(false);
  });

  it('keeps full absolute path for binaries outside $HOME', () => {
    // Custom deployments under /opt or /var have no relative form to
    // worry about, so the absolute path itself is the pattern.
    const pattern = buildKillPattern('/opt/obsd/server', '/home/alice');
    expect(pattern).toBe('/opt/obsd/server ');
  });

  it('handles $HOME with trailing slash', () => {
    expect(buildKillPattern('/home/alice/.obsidian-remote/server', '/home/alice/'))
      .toBe('\\.obsidian-remote/server ');
  });

  it('trailing space prevents prefix collisions', () => {
    const pattern = buildKillPattern('/home/alice/.obsidian-remote/server', '/home/alice');
    const re = new RegExp(pattern);
    // Must not match a sibling that shares the prefix.
    expect(re.test('.obsidian-remote/server-old --foo')).toBe(false);
    expect(re.test('.obsidian-remote/server-new')).toBe(false);
  });
});
