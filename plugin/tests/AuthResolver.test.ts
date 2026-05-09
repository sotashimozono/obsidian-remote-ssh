import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthResolver } from '../src/ssh/AuthResolver';
import type { SecretStore } from '../src/ssh/SecretStore';
import type { SshProfile } from '../src/types';

vi.mock('fs', () => ({ readFileSync: vi.fn() }));

import * as fs from 'fs';

function makeStore(initial: Record<string, string> = {}): SecretStore {
  const data = new Map(Object.entries(initial));
  return {
    get: (ref: string) => data.get(ref),
    set: (ref: string, val: string) => { data.set(ref, val); },
    delete: (ref: string) => { data.delete(ref); },
  } as unknown as SecretStore;
}

const baseProfile: SshProfile = {
  id: 'p1',
  name: 'test',
  host: 'host.example',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  remotePath: '~/vault',
  connectTimeoutMs: 10000,
  keepaliveIntervalMs: 5000,
  keepaliveCountMax: 3,
};

describe('AuthResolver — secret management', () => {
  it('storeSecret stores in session map and is retrievable via getSecret', () => {
    const r = new AuthResolver(makeStore());
    r.storeSecret('ref1', 'val1');
    expect(r.getSecret('ref1')).toBe('val1');
  });

  it('getSecret falls back to the persistent store when not in session map', () => {
    const store = makeStore({ persistedRef: 'fromStore' });
    const r = new AuthResolver(store);
    expect(r.getSecret('persistedRef')).toBe('fromStore');
  });

  it('session map takes precedence over the persistent store', () => {
    const store = makeStore({ ref: 'stored' });
    const r = new AuthResolver(store);
    r.storeSecret('ref', 'session');
    expect(r.getSecret('ref')).toBe('session');
  });

  it('persistSecret writes to session map AND the underlying store', () => {
    const setMock = vi.fn();
    const store = { get: vi.fn(), set: setMock, delete: vi.fn() } as unknown as SecretStore;
    const r = new AuthResolver(store);
    r.persistSecret('myRef', 'myVal');
    expect(r.getSecret('myRef')).toBe('myVal');
    expect(setMock).toHaveBeenCalledWith('myRef', 'myVal');
  });

  it('clearSecrets removes all session entries for a given profile id prefix', () => {
    const r = new AuthResolver(makeStore());
    r.storeSecret('p1:password', 'pw');
    r.storeSecret('p1:passphrase', 'pp');
    r.storeSecret('p2:password', 'other');
    r.clearSecrets('p1');
    expect(r.getSecret('p1:password')).toBeUndefined();
    expect(r.getSecret('p1:passphrase')).toBeUndefined();
    expect(r.getSecret('p2:password')).toBe('other');
  });

  it('getSecret returns undefined when ref is unknown in both maps', () => {
    const r = new AuthResolver(makeStore());
    expect(r.getSecret('unknown')).toBeUndefined();
  });
});

describe('AuthResolver.buildAuthConfig — password', () => {
  it('returns { password } when a password ref is stored', () => {
    const r = new AuthResolver(makeStore());
    r.storeSecret('pw-ref', 'secret123');
    const profile: SshProfile = { ...baseProfile, authMethod: 'password', passwordRef: 'pw-ref' };
    const cfg = r.buildAuthConfig(profile);
    expect(cfg).toEqual({ password: 'secret123' });
  });

  it('throws when no password is stored for the ref', () => {
    const r = new AuthResolver(makeStore());
    const profile: SshProfile = { ...baseProfile, authMethod: 'password', passwordRef: 'missing' };
    expect(() => r.buildAuthConfig(profile)).toThrow(/No password stored/);
  });

  it('throws when passwordRef is absent', () => {
    const r = new AuthResolver(makeStore());
    const profile: SshProfile = { ...baseProfile, authMethod: 'password', passwordRef: undefined };
    expect(() => r.buildAuthConfig(profile)).toThrow(/No password stored/);
  });
});

describe('AuthResolver.buildAuthConfig — privateKey', () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('---BEGIN KEY---'));
  });

  it('returns { privateKey } when key file is readable and no passphrase', () => {
    const r = new AuthResolver(makeStore());
    const profile: SshProfile = {
      ...baseProfile,
      authMethod: 'privateKey',
      // Use tilde prefix so expandHome is exercised; readFileSync is mocked.
      privateKeyPath: '~/.ssh/id_ed25519',
    };
    const cfg = r.buildAuthConfig(profile);
    expect(cfg).toMatchObject({ privateKey: expect.any(Buffer) });
    expect(cfg.passphrase).toBeUndefined();
  });

  it('includes passphrase when passphraseRef is stored', () => {
    const r = new AuthResolver(makeStore());
    r.storeSecret('pp-ref', 'myPassphrase');
    const profile: SshProfile = {
      ...baseProfile,
      authMethod: 'privateKey',
      privateKeyPath: '~/.ssh/id_ed25519',
      passphraseRef: 'pp-ref',
    };
    const cfg = r.buildAuthConfig(profile);
    expect(cfg.passphrase).toBe('myPassphrase');
  });

  it('throws when privateKeyPath is absent', () => {
    const r = new AuthResolver(makeStore());
    const profile: SshProfile = { ...baseProfile, authMethod: 'privateKey', privateKeyPath: undefined };
    expect(() => r.buildAuthConfig(profile)).toThrow(/No private key path/);
  });

  it('throws when readFileSync fails', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const r = new AuthResolver(makeStore());
    const profile: SshProfile = {
      ...baseProfile,
      authMethod: 'privateKey',
      // Path value doesn't matter; readFileSync is mocked to throw.
      privateKeyPath: 'nonexistent-key',
    };
    expect(() => r.buildAuthConfig(profile)).toThrow(/Cannot read private key/);
  });

  it('expands "~/" in privateKeyPath before reading the file', () => {
    const r = new AuthResolver(makeStore());
    const profile: SshProfile = {
      ...baseProfile,
      authMethod: 'privateKey',
      privateKeyPath: '~/.ssh/id_ed25519',
    };
    r.buildAuthConfig(profile);
    const calledPath = vi.mocked(fs.readFileSync).mock.calls[0][0] as string;
    expect(calledPath).not.toMatch(/^~/);
  });
});

describe('AuthResolver.buildAuthConfig — agent', () => {
  it('returns { agent } using profile.agentSocket when set', () => {
    const r = new AuthResolver(makeStore());
    const profile: SshProfile = {
      ...baseProfile,
      authMethod: 'agent',
      agentSocket: 'test-ssh-agent.socket',
    };
    const cfg = r.buildAuthConfig(profile);
    expect(cfg).toEqual({ agent: 'test-ssh-agent.socket' });
  });

  it('falls back to SSH_AUTH_SOCK env var when agentSocket is not set', () => {
    const orig = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = 'test-ssh-auth.sock';
    try {
      const r = new AuthResolver(makeStore());
      const profile: SshProfile = { ...baseProfile, authMethod: 'agent', agentSocket: undefined };
      const cfg = r.buildAuthConfig(profile);
      expect(cfg).toEqual({ agent: 'test-ssh-auth.sock' });
    } finally {
      if (orig === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = orig;
    }
  });

  it('throws when neither agentSocket nor SSH_AUTH_SOCK is set', () => {
    const orig = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      const r = new AuthResolver(makeStore());
      const profile: SshProfile = { ...baseProfile, authMethod: 'agent', agentSocket: undefined };
      expect(() => r.buildAuthConfig(profile)).toThrow(/SSH_AUTH_SOCK/);
    } finally {
      if (orig !== undefined) process.env.SSH_AUTH_SOCK = orig;
    }
  });
});

describe('AuthResolver.buildAuthConfig — unknown method', () => {
  it('throws for an unrecognised authMethod value', () => {
    const r = new AuthResolver(makeStore());
    const profile = { ...baseProfile, authMethod: 'magic' as SshProfile['authMethod'] };
    expect(() => r.buildAuthConfig(profile)).toThrow(/Unknown auth method/);
  });
});
