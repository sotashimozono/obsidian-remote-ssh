import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSshConfig } from '../src/ssh/SshConfigReader';

/**
 * Each test writes a small ssh_config-like file to a temp dir and
 * points readSshConfig at it; that's faster and more robust than
 * mocking `fs`. Files are cleaned up in afterEach.
 */
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-cfg-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(content: string): string {
  const p = path.join(tmpDir, 'config');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('readSshConfig: missing / empty file', () => {
  it('returns [] when the file does not exist', () => {
    expect(readSshConfig(path.join(tmpDir, 'nope'))).toEqual([]);
  });

  it('returns [] for an empty file', () => {
    const p = write('');
    expect(readSshConfig(p)).toEqual([]);
  });

  it('skips comments and blank lines', () => {
    const p = write([
      '# this is a comment',
      '',
      'Host foo',
      '  HostName foo.example.com',
      '',
      '# another comment',
    ].join('\n'));
    const entries = readSshConfig(p);
    expect(entries).toHaveLength(1);
    expect(entries[0].hostname).toBe('foo.example.com');
  });
});

describe('readSshConfig: single host', () => {
  it('reads HostName / User / Port / IdentityFile', () => {
    const p = write([
      'Host srv',
      '  HostName srv.example.com',
      '  User alice',
      '  Port 2222',
      '  IdentityFile /home/alice/.ssh/id_ed25519',
    ].join('\n'));
    expect(readSshConfig(p)).toEqual([
      {
        alias: 'srv',
        hostname: 'srv.example.com',
        user: 'alice',
        port: 2222,
        identityFile: '/home/alice/.ssh/id_ed25519',
        proxyJump: undefined,
      },
    ]);
  });

  it('expands ~ in IdentityFile', () => {
    const p = write([
      'Host srv',
      '  HostName srv.example.com',
      '  IdentityFile ~/.ssh/id_ed25519',
    ].join('\n'));
    const entry = readSshConfig(p)[0];
    expect(entry.identityFile).toBe(path.join(os.homedir(), '.ssh', 'id_ed25519'));
  });

  it('falls back hostname → alias when HostName is missing', () => {
    const p = write([
      'Host srv',
      '  User alice',
    ].join('\n'));
    expect(readSshConfig(p)[0].hostname).toBe('srv');
  });

  it('falls back port → 22 and user → OS username', () => {
    const p = write([
      'Host srv',
      '  HostName srv.example.com',
    ].join('\n'));
    const entry = readSshConfig(p)[0];
    expect(entry.port).toBe(22);
    expect(entry.user).toBeTruthy(); // os.userInfo().username; non-empty everywhere we run
  });
});

describe('readSshConfig: multi-pattern Host line', () => {
  it('expands `Host foo bar` to two entries with shared body', () => {
    const p = write([
      'Host foo bar',
      '  HostName 10.0.0.1',
      '  User shared',
    ].join('\n'));
    const entries = readSshConfig(p);
    expect(entries.map(e => e.alias).sort()).toEqual(['bar', 'foo']);
    for (const e of entries) {
      expect(e.hostname).toBe('10.0.0.1');
      expect(e.user).toBe('shared');
    }
  });

  it('skips wildcard patterns inside a multi-pattern line', () => {
    const p = write([
      'Host explicit *.wild',
      '  User mixed',
    ].join('\n'));
    const entries = readSshConfig(p);
    expect(entries.map(e => e.alias)).toEqual(['explicit']);
  });
});

describe('readSshConfig: Host * defaults', () => {
  it('applies defaults to non-wildcard entries that don\'t override them', () => {
    const p = write([
      'Host *',
      '  User defaultuser',
      '  IdentityFile /key',
      '',
      'Host srv',
      '  HostName srv.example.com',
    ].join('\n'));
    const entry = readSshConfig(p)[0];
    expect(entry.user).toBe('defaultuser');
    expect(entry.identityFile).toBe('/key');
  });

  it('lets specific Host blocks override defaults', () => {
    const p = write([
      'Host *',
      '  User defaultuser',
      '',
      'Host srv',
      '  HostName srv.example.com',
      '  User specific',
    ].join('\n'));
    expect(readSshConfig(p)[0].user).toBe('specific');
  });

  it('does not include the * block itself in the output', () => {
    const p = write([
      'Host *',
      '  User defaultuser',
      '',
      'Host srv',
      '  HostName srv.example.com',
    ].join('\n'));
    expect(readSshConfig(p).map(e => e.alias)).toEqual(['srv']);
  });
});

describe('readSshConfig: ProxyJump', () => {
  it('parses a literal hostname', () => {
    const p = write([
      'Host srv',
      '  HostName srv.example.com',
      '  User alice',
      '  ProxyJump bastion.example.com',
    ].join('\n'));
    const entry = readSshConfig(p)[0];
    expect(entry.proxyJump).toEqual({
      host: 'bastion.example.com',
      port: 22,
      user: 'alice',           // inherits from parent host
      identityFile: undefined,
    });
  });

  it('parses [user@]host[:port]', () => {
    const p = write([
      'Host srv',
      '  HostName srv.example.com',
      '  User alice',
      '  ProxyJump bob@bastion.example.com:2222',
    ].join('\n'));
    const entry = readSshConfig(p)[0];
    expect(entry.proxyJump).toEqual({
      host: 'bastion.example.com',
      port: 2222,
      user: 'bob',
      identityFile: undefined,
    });
  });

  it('takes only the first hop of a chain', () => {
    const p = write([
      'Host srv',
      '  ProxyJump first.example.com,second.example.com',
    ].join('\n'));
    expect(readSshConfig(p)[0].proxyJump?.host).toBe('first.example.com');
  });

  it('resolves a referenced Host alias to its HostName/Port/User/IdentityFile', () => {
    const p = write([
      'Host bastion',
      '  HostName 10.0.0.99',
      '  User bastionuser',
      '  Port 2200',
      '  IdentityFile /bkey',
      '',
      'Host srv',
      '  HostName srv.example.com',
      '  ProxyJump bastion',
    ].join('\n'));
    const srv = readSshConfig(p).find(e => e.alias === 'srv')!;
    expect(srv.proxyJump).toEqual({
      host: '10.0.0.99',
      port: 2200,
      user: 'bastionuser',
      identityFile: '/bkey',
    });
  });

  it('lets an explicit ProxyJump port override the referenced alias\'s port', () => {
    const p = write([
      'Host bastion',
      '  HostName 10.0.0.99',
      '  Port 2200',
      '',
      'Host srv',
      '  ProxyJump bastion:9999',
    ].join('\n'));
    const srv = readSshConfig(p).find(e => e.alias === 'srv')!;
    expect(srv.proxyJump?.port).toBe(9999);
  });

  it('still works when the referenced alias is declared after the host that uses it', () => {
    const p = write([
      'Host srv',
      '  ProxyJump bastion',
      '',
      'Host bastion',
      '  HostName 10.0.0.99',
    ].join('\n'));
    const srv = readSshConfig(p).find(e => e.alias === 'srv')!;
    expect(srv.proxyJump?.host).toBe('10.0.0.99');
  });
});
