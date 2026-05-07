import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loggerMock,
  installErrorHookMock,
  uninstallErrorHookMock,
} = vi.hoisted(() => ({
  loggerMock: {
    installFileSink: vi.fn(),
    uninstallFileSink: vi.fn().mockResolvedValue(undefined),
    wrapConsole: vi.fn(),
    unwrapConsole: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  installErrorHookMock: vi.fn(),
  uninstallErrorHookMock: vi.fn(),
}));

vi.mock('../src/util/logger', () => ({ logger: loggerMock }));
vi.mock('../src/util/errorHook', () => ({
  installErrorHook: installErrorHookMock,
  uninstallErrorHook: uninstallErrorHookMock,
}));

import { ObservabilityInstaller } from '../src/util/ObservabilityInstaller';

describe('ObservabilityInstaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerMock.uninstallFileSink.mockResolvedValue(undefined);
  });

  it('installs file sink + hooks and logs plugin load when vault path exists', () => {
    const installer = new ObservabilityInstaller(
      { id: 'remote-ssh', version: '1.2.3' },
      '/vault',
      '.obsidian',
    );

    installer.install();

    expect(loggerMock.installFileSink).toHaveBeenCalledWith('/vault/.obsidian/plugins/remote-ssh/console.log');
    expect(loggerMock.wrapConsole).toHaveBeenCalledTimes(1);
    expect(installErrorHookMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith('Plugin remote-ssh v1.2.3 loaded');
  });

  it('warns and skips file sink when vault path is null', () => {
    const installer = new ObservabilityInstaller(
      { id: 'remote-ssh', version: '1.2.3' },
      null,
      '.obsidian',
    );

    installer.install();

    expect(loggerMock.installFileSink).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith('vault.adapter is not FileSystemAdapter; file sink disabled');
    expect(loggerMock.wrapConsole).toHaveBeenCalledTimes(1);
    expect(installErrorHookMock).toHaveBeenCalledTimes(1);
  });

  it('logs installFileSink failures and still installs other observability hooks', () => {
    loggerMock.installFileSink.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const installer = new ObservabilityInstaller(
      { id: 'remote-ssh', version: '1.2.3' },
      '/vault',
      '.obsidian',
    );

    installer.install();

    expect(loggerMock.warn).toHaveBeenCalledWith('installFileSink failed: disk full');
    expect(loggerMock.wrapConsole).toHaveBeenCalledTimes(1);
    expect(installErrorHookMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith('Plugin remote-ssh v1.2.3 loaded');
  });

  it('uninstalls hooks, console wrapper, and file sink in teardown path', () => {
    const installer = new ObservabilityInstaller(
      { id: 'remote-ssh', version: '1.2.3' },
      '/vault',
      '.obsidian',
    );

    installer.uninstall();

    expect(loggerMock.info).toHaveBeenCalledWith('Plugin remote-ssh unloading');
    expect(uninstallErrorHookMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.unwrapConsole).toHaveBeenCalledTimes(1);
    expect(loggerMock.uninstallFileSink).toHaveBeenCalledTimes(1);
  });
});
