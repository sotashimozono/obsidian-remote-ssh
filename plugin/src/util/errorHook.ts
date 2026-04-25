import { logger } from './logger';

let installed = false;
let onUnhandledRejection: ((e: PromiseRejectionEvent) => void) | null = null;
let onError: ((e: ErrorEvent) => void) | null = null;

export function installErrorHook(): void {
  if (installed) return;
  installed = true;

  onUnhandledRejection = (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    let msg: string;
    if (reason instanceof Error) {
      msg = `unhandledrejection: ${reason.message}\n${reason.stack ?? ''}`;
    } else {
      try { msg = `unhandledrejection: ${JSON.stringify(reason)}`; }
      catch { msg = `unhandledrejection: ${String(reason)}`; }
    }
    logger.error(msg);
  };

  onError = (e) => {
    const stack = e.error instanceof Error ? e.error.stack : undefined;
    logger.error(
      `window.onerror: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}` +
      (stack ? `\n${stack}` : '')
    );
  };

  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('error', onError);
}

export function uninstallErrorHook(): void {
  if (!installed) return;
  installed = false;
  if (onUnhandledRejection) {
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    onUnhandledRejection = null;
  }
  if (onError) {
    window.removeEventListener('error', onError);
    onError = null;
  }
}
