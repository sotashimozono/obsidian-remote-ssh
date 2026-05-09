import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// errorHook.ts has module-level `installed` state. Reset modules before each
// test so we always start with installed=false and fresh handler references.

let installErrorHook: () => void;
let uninstallErrorHook: () => void;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../src/util/errorHook');
  installErrorHook = mod.installErrorHook;
  uninstallErrorHook = mod.uninstallErrorHook;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installErrorHook', () => {
  it('registers unhandledrejection and error listeners on window', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    installErrorHook();
    const eventTypes = spy.mock.calls.map(([type]) => type);
    expect(eventTypes).toContain('unhandledrejection');
    expect(eventTypes).toContain('error');
  });

  it('is idempotent — a second call adds no further listeners', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    installErrorHook();
    const firstCount = spy.mock.calls.length;
    installErrorHook();
    expect(spy.mock.calls.length).toBe(firstCount);
  });
});

describe('uninstallErrorHook', () => {
  it('removes both listeners that were registered by install', () => {
    installErrorHook();
    const spy = vi.spyOn(window, 'removeEventListener');
    uninstallErrorHook();
    const eventTypes = spy.mock.calls.map(([type]) => type);
    expect(eventTypes).toContain('unhandledrejection');
    expect(eventTypes).toContain('error');
  });

  it('is a no-op when not yet installed', () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    uninstallErrorHook();
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows re-installation after uninstall', () => {
    installErrorHook();
    uninstallErrorHook();
    const spy = vi.spyOn(window, 'addEventListener');
    installErrorHook();
    const eventTypes = spy.mock.calls.map(([type]) => type);
    expect(eventTypes).toContain('unhandledrejection');
    expect(eventTypes).toContain('error');
  });
});

describe('unhandledrejection handler', () => {
  it('logs Error reason including the message text', async () => {
    const loggerMod = await import('../src/util/logger');
    const spy = vi.spyOn(loggerMod.logger, 'error').mockImplementation(() => {});
    installErrorHook();

    const err = new Error('test-rejection');
    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: err });
    window.dispatchEvent(event);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('test-rejection'));
    uninstallErrorHook();
  });

  it('logs non-Error reason via JSON.stringify', async () => {
    const loggerMod = await import('../src/util/logger');
    const spy = vi.spyOn(loggerMod.logger, 'error').mockImplementation(() => {});
    installErrorHook();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: { code: 42 } });
    window.dispatchEvent(event);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"code":42'));
    uninstallErrorHook();
  });

  it('falls back to String() for non-serializable (circular) reasons', async () => {
    const loggerMod = await import('../src/util/logger');
    const spy = vi.spyOn(loggerMod.logger, 'error').mockImplementation(() => {});
    installErrorHook();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: circular });
    window.dispatchEvent(event);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unhandledrejection'));
    uninstallErrorHook();
  });
});

describe('window error handler', () => {
  it('logs window.onerror events with file/line/col info', async () => {
    const loggerMod = await import('../src/util/logger');
    const spy = vi.spyOn(loggerMod.logger, 'error').mockImplementation(() => {});
    installErrorHook();

    const event = new ErrorEvent('error', {
      message: 'uncaught-error',
      filename: 'main.js',
      lineno: 10,
      colno: 5,
    });
    window.dispatchEvent(event);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('window.onerror: uncaught-error'));
    uninstallErrorHook();
  });

  it('includes the stack trace when the error has one', async () => {
    const loggerMod = await import('../src/util/logger');
    const spy = vi.spyOn(loggerMod.logger, 'error').mockImplementation(() => {});
    installErrorHook();

    const err = new Error('stack-error');
    const event = new ErrorEvent('error', {
      message: 'stack-error',
      filename: 'a.js',
      lineno: 1,
      colno: 1,
      error: err,
    });
    window.dispatchEvent(event);

    const msg: string = spy.mock.calls[0][0] as string;
    expect(msg).toContain('window.onerror');
    expect(msg).toContain('stack-error');
    uninstallErrorHook();
  });
});
