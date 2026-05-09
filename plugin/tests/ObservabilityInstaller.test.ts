import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginManifest } from 'obsidian';

vi.mock('../src/util/logger', () => ({
  logger: {
    installFileSink: vi.fn().mockResolvedValue(undefined),
    wrapConsole: vi.fn(),
    unwrapConsole: vi.fn(),
    uninstallFileSink: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/util/errorHook', () => ({
  installErrorHook: vi.fn(),
  uninstallErrorHook: vi.fn(),
}));

import { ObservabilityInstaller } from '../src/util/ObservabilityInstaller';
import { logger } from '../src/util/logger';
import { installErrorHook, uninstallErrorHook } from '../src/util/errorHook';

const manifest: PluginManifest = {
  id: 'remote-ssh',
  name: 'Remote SSH',
  version: '1.0.0',
  minAppVersion: '1.0.0',
  description: '',
  author: '',
  isDesktopOnly: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ObservabilityInstaller.install', () => {
  it('installs the file sink at a path containing the plugin id and "console.log"', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.install();
    expect(vi.mocked(logger.installFileSink)).toHaveBeenCalledWith(
      expect.stringContaining('remote-ssh'),
    );
    expect(vi.mocked(logger.installFileSink)).toHaveBeenCalledWith(
      expect.stringContaining('console.log'),
    );
  });

  it('skips the file sink and warns when vaultBasePath is null', () => {
    const installer = new ObservabilityInstaller(manifest, null, '.obsidian');
    installer.install();
    expect(vi.mocked(logger.installFileSink)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('file sink disabled'),
    );
  });

  it('calls wrapConsole', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.install();
    expect(vi.mocked(logger.wrapConsole)).toHaveBeenCalled();
  });

  it('calls installErrorHook', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.install();
    expect(installErrorHook).toHaveBeenCalled();
  });

  it('logs a load message containing the plugin id and version', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.install();
    const infoArg = vi.mocked(logger.info).mock.calls.map((c) => c[0]).join(' ');
    expect(infoArg).toContain('remote-ssh');
    expect(infoArg).toContain('1.0.0');
  });

  it('warns instead of throwing when installFileSink throws', () => {
    vi.mocked(logger.installFileSink).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    expect(() => installer.install()).not.toThrow();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('installFileSink failed'),
    );
  });

  it('uses the provided configDir to build the log path', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', 'custom.obsidian');
    installer.install();
    expect(vi.mocked(logger.installFileSink)).toHaveBeenCalledWith(
      expect.stringContaining('custom.obsidian'),
    );
  });
});

describe('ObservabilityInstaller.uninstall', () => {
  it('calls uninstallErrorHook', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.uninstall();
    expect(uninstallErrorHook).toHaveBeenCalled();
  });

  it('calls unwrapConsole', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.uninstall();
    expect(vi.mocked(logger.unwrapConsole)).toHaveBeenCalled();
  });

  it('calls uninstallFileSink', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.uninstall();
    expect(vi.mocked(logger.uninstallFileSink)).toHaveBeenCalled();
  });

  it('logs an unloading message containing the plugin id', () => {
    const installer = new ObservabilityInstaller(manifest, '/vault', '.obsidian');
    installer.uninstall();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('remote-ssh'),
    );
  });
});
