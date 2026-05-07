import { afterEach, describe, expect, it, vi } from 'vitest';
import { installErrorHook, uninstallErrorHook } from '../src/util/errorHook';
import { logger } from '../src/util/logger';

describe('errorHook', () => {
  afterEach(() => {
    uninstallErrorHook();
    vi.restoreAllMocks();
  });

  it('installs only once and unregisters both listeners on uninstall', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    installErrorHook();
    installErrorHook();

    expect(add).toHaveBeenCalledTimes(2);
    uninstallErrorHook();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.map(([name]) => name)).toEqual(['unhandledrejection', 'error']);
  });

  it('logs unhandled rejection details for Error reasons', () => {
    let onUnhandled: ((e: PromiseRejectionEvent) => void) | undefined;
    vi.spyOn(window, 'addEventListener').mockImplementation(
      ((name: string, cb: EventListenerOrEventListenerObject) => {
        if (name === 'unhandledrejection') onUnhandled = cb as (e: PromiseRejectionEvent) => void;
      }) as typeof window.addEventListener,
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    installErrorHook();
    onUnhandled?.({ reason: new Error('boom') } as PromiseRejectionEvent);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('unhandledrejection: boom');
  });

  it('serializes plain object reason via JSON.stringify', () => {
    let onUnhandled: ((e: PromiseRejectionEvent) => void) | undefined;
    vi.spyOn(window, 'addEventListener').mockImplementation(
      ((name: string, cb: EventListenerOrEventListenerObject) => {
        if (name === 'unhandledrejection') onUnhandled = cb as (e: PromiseRejectionEvent) => void;
      }) as typeof window.addEventListener,
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    installErrorHook();
    onUnhandled?.({ reason: { code: 404 } } as PromiseRejectionEvent);

    expect(error.mock.calls[0]?.[0]).toBe('unhandledrejection: {"code":404}');
  });

  it('falls back to String(reason) when JSON.stringify throws', () => {
    let onUnhandled: ((e: PromiseRejectionEvent) => void) | undefined;
    vi.spyOn(window, 'addEventListener').mockImplementation(
      ((name: string, cb: EventListenerOrEventListenerObject) => {
        if (name === 'unhandledrejection') onUnhandled = cb as (e: PromiseRejectionEvent) => void;
      }) as typeof window.addEventListener,
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    installErrorHook();
    onUnhandled?.({ reason: circular } as PromiseRejectionEvent);

    expect(error.mock.calls[0]?.[0]).toBe('unhandledrejection: [object Object]');
  });

  it('logs window.onerror with location and stack when available', () => {
    let onError: ((e: ErrorEvent) => void) | undefined;
    vi.spyOn(window, 'addEventListener').mockImplementation(
      ((name: string, cb: EventListenerOrEventListenerObject) => {
        if (name === 'error') onError = cb as (e: ErrorEvent) => void;
      }) as typeof window.addEventListener,
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    installErrorHook();
    onError?.({
      message: 'kaput',
      filename: 'main.ts',
      lineno: 12,
      colno: 4,
      error: new Error('kaput'),
    } as ErrorEvent);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('window.onerror: kaput at main.ts:12:4');
    expect(error.mock.calls[0]?.[0]).toContain('Error: kaput');
  });

  it('logs window.onerror without stack when error is not an Error instance', () => {
    let onError: ((e: ErrorEvent) => void) | undefined;
    vi.spyOn(window, 'addEventListener').mockImplementation(
      ((name: string, cb: EventListenerOrEventListenerObject) => {
        if (name === 'error') onError = cb as (e: ErrorEvent) => void;
      }) as typeof window.addEventListener,
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    installErrorHook();
    onError?.({
      message: 'script error',
      filename: 'vendor.js',
      lineno: 1,
      colno: 0,
      error: null,
    } as ErrorEvent);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBe('window.onerror: script error at vendor.js:1:0');
    expect(error.mock.calls[0]?.[0]).not.toContain('\n');
  });
});
