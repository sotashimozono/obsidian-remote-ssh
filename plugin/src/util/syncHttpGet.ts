import { logger } from './logger';
import { errorMessage } from './errorMessage';

/** Outcome of {@link syncHttpGetBinary}. */
export type SyncGetResult =
  | { kind: 'ok'; bytes: Buffer }
  /** The resource is larger than `maxBytes`; nothing was materialised. */
  | { kind: 'too-large'; totalSize: number }
  /** No vehicle, or the request failed. `why` is for the log, not the user. */
  | { kind: 'unavailable'; why: string };

/** Logged once per session — a missing vehicle is a fact, not a per-call event. */
let vehicleReported = false;

/**
 * Fetch a localhost URL **synchronously** and return its bytes.
 *
 * This exists for `getFullPath` / `getFilePath`, which are synchronous
 * in Obsidian's `DataAdapter` API: a plugin calls one and then
 * immediately opens the path it got back. Returning a path and
 * materialising it asynchronously would lose that race, so the fetch
 * has to block.
 *
 * The vehicle is a synchronous `XMLHttpRequest` against the
 * ResourceBridge (already running on 127.0.0.1 behind a per-session
 * token). Synchronous XHR cannot use `responseType`, so the body comes
 * back through `overrideMimeType('text/plain; charset=x-user-defined')`,
 * which maps each byte to one code unit — the standard way to read
 * binary out of a synchronous request.
 *
 * `Range: bytes=0-(maxBytes-1)` is sent so an over-budget file is
 * recognised from `Content-Range` without transferring all of it
 * (a transport that cannot honour a range still sends the whole body;
 * it is then discarded rather than written to disk).
 *
 * Never throws: every failure is a `kind: 'unavailable'` the caller
 * degrades on.
 */
export function syncHttpGetBinary(url: string, maxBytes: number): SyncGetResult {
  // `activeWindow` is Obsidian's handle on the window the user is
  // actually in (pop-out windows have their own); it is absent outside
  // Obsidian, where the plain `window` is the right — and only — scope.
  const scope = (typeof activeWindow !== 'undefined' ? activeWindow : window) as unknown as
    { XMLHttpRequest?: new () => XMLHttpRequest } | undefined;
  const XHRCtor = scope?.XMLHttpRequest;
  if (typeof XHRCtor !== 'function') {
    if (!vehicleReported) {
      vehicleReported = true;
      logger.info(
        'syncHttpGetBinary: no XMLHttpRequest in this context — on-demand materialisation is off',
      );
    }
    return { kind: 'unavailable', why: 'no XMLHttpRequest' };
  }
  try {
    const xhr = new XHRCtor();
    xhr.open('GET', url, false);
    xhr.setRequestHeader('Range', `bytes=0-${Math.max(0, maxBytes - 1)}`);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send();

    if (xhr.status !== 200 && xhr.status !== 206) {
      return { kind: 'unavailable', why: `HTTP ${xhr.status}` };
    }
    const total = totalFromContentRange(xhr.getResponseHeader('Content-Range'));
    if (total !== null && total > maxBytes) {
      return { kind: 'too-large', totalSize: total };
    }
    const text = xhr.responseText;
    if (text.length > maxBytes) {
      return { kind: 'too-large', totalSize: text.length };
    }
    const out = Buffer.allocUnsafe(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return { kind: 'ok', bytes: out };
  } catch (e) {
    if (!vehicleReported) {
      vehicleReported = true;
      logger.info(`syncHttpGetBinary: synchronous request failed (${errorMessage(e)})`);
    }
    return { kind: 'unavailable', why: errorMessage(e) };
  }
}

/** `bytes 0-1023/4096` → 4096. Null when the header is absent or unparseable. */
export function totalFromContentRange(header: string | null): number | null {
  if (!header) return null;
  const m = /\/\s*(\d+)\s*$/.exec(header);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
