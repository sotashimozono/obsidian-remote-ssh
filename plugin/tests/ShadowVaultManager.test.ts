import { describe, it, expect, vi } from 'vitest';
import { ShadowVaultManager } from '../src/shadow/ShadowVaultManager';
import type { ShadowVaultBootstrap, BootstrapResult } from '../src/shadow/ShadowVaultBootstrap';
import type { WindowSpawner } from '../src/shadow/WindowSpawner';
import type { SshProfile } from '../src/types';

function makeProfile(id: string, name = id): SshProfile {
  return {
    id, name,
    host: 'h', port: 22, username: 'u', authMethod: 'privateKey',
    remotePath: '~/v/', privateKeyPath: '/dev/null',
    connectTimeoutMs: 5000, keepaliveIntervalMs: 10000, keepaliveCountMax: 3,
  } as SshProfile;
}

describe('ShadowVaultManager.openShadowFor', () => {
  it('runs bootstrap then spawn, in that order, with the right args', async () => {
    const order: string[] = [];
    const fakeResult: BootstrapResult = {
      layout: {
        vaultDir: '/tmp/v', configDir: '/tmp/v/.obsidian',
        pluginDir: '/tmp/v/.obsidian/plugins/remote-ssh',
        pluginDataFile: '/tmp/v/.obsidian/plugins/remote-ssh/data.json',
      },
      registryId: 'abc', registryCreated: true, pluginInstallMethod: 'symlink',
    };
    const bootstrap = {
      bootstrap: vi.fn(async (..._args: unknown[]) => { order.push('bootstrap'); return fakeResult; }),
    } as unknown as ShadowVaultBootstrap;
    const spawner = {
      spawn: vi.fn((..._args: unknown[]) => { order.push('spawn'); return ''; }),
    } as unknown as WindowSpawner;

    const profile = makeProfile('p1');
    const all = [profile, makeProfile('p2')];
    const result = await new ShadowVaultManager(bootstrap, spawner).openShadowFor(profile, all);

    expect(order).toEqual(['bootstrap', 'spawn']);
    expect(bootstrap.bootstrap).toHaveBeenCalledWith(profile, all);
    expect(spawner.spawn).toHaveBeenCalledWith('/tmp/v');
    expect(result).toBe(fakeResult);
  });

  it('does NOT spawn if bootstrap throws', async () => {
    const bootstrap = {
      bootstrap: vi.fn(async () => { throw new Error('disk full'); }),
    } as unknown as ShadowVaultBootstrap;
    const spawner = {
      spawn: vi.fn(() => ''),
    } as unknown as WindowSpawner;

    const profile = makeProfile('p1');
    await expect(
      new ShadowVaultManager(bootstrap, spawner).openShadowFor(profile, [profile]),
    ).rejects.toThrow(/disk full/);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });
});
