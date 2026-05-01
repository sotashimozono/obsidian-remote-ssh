import { asError } from '../util/errorMessage';

// Phase D-γ — error taxonomy (F18).
//
// Classifies arbitrary thrown errors (RpcError from the daemon,
// ssh2 errors from the SSH layer, Node socket errors, plain Error
// from precondition / parse paths) into a small enum of
// **user-actionable categories**. Each category carries a short
// title (suitable for `new Notice(...)`) and a longer hint that
// answers "what should I do about this?".
//
// The original error is preserved verbatim on the result so the
// caller can still log the underlying message + stack via the
// JSONL Logger's `fields` overload (Phase D-β / F20).
//
// Pure module — no dependencies on the SSH stack, the RPC client,
// or the Obsidian Notice API. The Notice / StatusBar wiring lives
// at the call site; this file just produces the structured payload.

import { ErrorCode } from '../proto/types';
import { RpcError } from './RpcError';

export type ErrorCategory =
  /** Auth handshake failed — bad key, wrong passphrase, password rejected. */
  | 'auth'
  /** Host key didn't match the pinned fingerprint (TOFU mismatch). */
  | 'host-key'
  /** Network unreachable — DNS failure, no route, refused connection. */
  | 'network'
  /** Connect / keepalive / RPC call timed out. */
  | 'timeout'
  /** Daemon couldn't read or write because of FS permissions. */
  | 'permission'
  /** A path is outside the daemon's vault root (sandbox guard). */
  | 'sandbox'
  /** Write rejected with PreconditionFailed — file changed under us. */
  | 'precondition'
  /** Path doesn't exist on the remote. */
  | 'not-found'
  /** Tried to operate on a directory as a file (or vice versa). */
  | 'wrong-kind'
  /** Wire protocol broke — parse error, version mismatch, etc. */
  | 'protocol'
  /** Generic daemon InternalError — server-side bug or transient hiccup. */
  | 'internal'
  /** Couldn't classify; surface the raw message as-is. */
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  /** One-line, user-facing. Drops into `new Notice(title)` directly. */
  title: string;
  /** Recovery hint — what to check / try next. May be 1-2 sentences. */
  hint: string;
  /** Verbatim original error, never mutated. */
  original: Error;
  /**
   * Numeric code if one was attached (RpcError.code, ssh2 errno, etc).
   * Useful for the Logger's `fields` payload + for downstream branches
   * that want a cheaper test than `category === 'auth'`.
   */
  code?: number | string;
}

/**
 * Classify any thrown value. Always returns a result — the
 * `'unknown'` category catches the long tail and copies the
 * original message into the title so the surface still gives the
 * user *something*.
 */
export function classifyError(err: unknown): ClassifiedError {
  const original = asError(err);

  if (err instanceof RpcError) {
    return classifyRpcError(err);
  }

  // ssh2 emits errors with a `level` property for auth-stage
  // failures. Common values: `client-authentication`, `protocol`.
  const ssh2Level = readMaybeString(err, 'level');
  if (ssh2Level === 'client-authentication') {
    return {
      category: 'auth',
      title: 'SSH authentication failed',
      hint: 'Check the profile\'s key path / passphrase / agent socket. The remote may also have rejected the user; try `ssh -v <user>@<host>` to confirm.',
      original,
    };
  }
  if (ssh2Level === 'protocol') {
    return {
      category: 'protocol',
      title: 'SSH protocol error',
      hint: 'The remote daemon rejected the SSH handshake. Possible causes: stale daemon process, mismatched protocol version, or a misconfigured sshd.',
      original,
    };
  }

  // Node-style socket errors carry a `code` string. Map the well-
  // known network ones; anything else falls through to message-
  // pattern matching.
  const sysCode = readMaybeString(err, 'code');
  if (sysCode) {
    const cat = mapSyscallCode(sysCode);
    if (cat) {
      return { ...cat, original, code: sysCode };
    }
  }

  // Last resort — match well-known substrings in the message.
  // Keep this short and high-signal; most genuine matches go
  // through one of the typed paths above.
  const msg = original.message ?? '';
  if (/host key/i.test(msg) || /fingerprint mismatch/i.test(msg)) {
    return {
      category: 'host-key',
      title: 'Remote host key changed',
      hint: 'The remote\'s host key doesn\'t match what we have on file. Reconnect to see the host-key change dialog and decide whether to trust the new key; if the change is unexpected, the host may have been swapped (or the connection intercepted).',
      original,
    };
  }
  if (/timed out|timeout/i.test(msg)) {
    return {
      category: 'timeout',
      title: 'Connection timed out',
      hint: 'The remote didn\'t respond in time. Check whether the host is reachable (ping / `ssh -v`) and whether a corporate firewall is throttling SSH.',
      original,
    };
  }

  return {
    category: 'unknown',
    title: original.message || 'Remote SSH: unknown error',
    // Hint is intentionally configDir-agnostic: the user may have
    // remapped Obsidian's config directory away from the default name,
    // and we don't have an `App` reference here to read
    // `app.vault.configDir`. Pointing them at "the plugin's data
    // folder" is enough; Obsidian's own settings tab shows the actual
    // location.
    hint: 'Open the plugin\'s log file (`<vault>/<configDir>/plugins/remote-ssh/console.log`) for the full stack — the JSONL line for this error carries the original message + any structured context.',
    original,
  };
}

// ── internals ───────────────────────────────────────────────────────────

function classifyRpcError(err: RpcError): ClassifiedError {
  const original = err;
  const code = err.code;
  switch (code) {
    case ErrorCode.AuthRequired:
      return {
        category: 'auth',
        title: 'Daemon authentication required',
        hint: 'The daemon\'s session token wasn\'t accepted. The token file on the remote may have rotated; reconnect to redeploy the daemon and refresh the token.',
        original, code,
      };
    case ErrorCode.AuthInvalid:
      return {
        category: 'auth',
        title: 'Daemon authentication invalid',
        hint: 'Token mismatch with the daemon. The daemon may be from an older deploy; reconnect to redeploy a fresh binary + token.',
        original, code,
      };
    case ErrorCode.FileNotFound:
      return {
        category: 'not-found',
        title: 'File not found on the remote',
        hint: 'The path doesn\'t exist on the remote vault. If you expected it to be there, check the profile\'s remotePath and that the file wasn\'t deleted out-of-band.',
        original, code,
      };
    case ErrorCode.NotADirectory:
    case ErrorCode.IsADirectory:
      return {
        category: 'wrong-kind',
        title: 'Wrong file kind',
        hint: 'The remote path is a file when a directory was expected (or vice versa). This usually means the local view drifted from the remote tree — try reconnecting.',
        original, code,
      };
    case ErrorCode.Exists:
      return {
        category: 'wrong-kind',
        title: 'Path already exists',
        hint: 'The remote already has a file at this path; the daemon refused to overwrite. Pick a different name or remove the existing file first.',
        original, code,
      };
    case ErrorCode.PermissionDenied:
      return {
        category: 'permission',
        title: 'Permission denied on the remote',
        hint: 'The daemon can\'t read or write this path under the SSH user\'s permissions. `chmod` / `chown` the path, or pick a remote vault root the user owns.',
        original, code,
      };
    case ErrorCode.PathOutsideVault:
      return {
        category: 'sandbox',
        title: 'Path is outside the vault root',
        hint: 'The plugin tried to read or write a path the daemon refuses to expose. This is a guardrail — usually means a misconfigured profile remotePath or a path-traversal attempt.',
        original, code,
      };
    case ErrorCode.PreconditionFailed:
      return {
        category: 'precondition',
        title: 'Write conflict — file changed remotely',
        hint: 'Another writer changed the file after you opened it. Reload the file to see the remote version, then merge your edits and save again.',
        original, code,
      };
    case ErrorCode.ProtocolVersionTooOld:
      return {
        category: 'protocol',
        title: 'Daemon protocol version too old',
        hint: 'The remote daemon predates this plugin version. Reconnect to redeploy the bundled daemon binary, or update the daemon by hand.',
        original, code,
      };
    case ErrorCode.ParseError:
    case ErrorCode.InvalidRequest:
    case ErrorCode.MethodNotFound:
    case ErrorCode.InvalidParams:
      return {
        category: 'protocol',
        title: 'Daemon rejected the request',
        hint: 'The plugin sent a malformed call. This is a plugin bug; the JSONL log line carries the method + params for filing an issue.',
        original, code,
      };
    case ErrorCode.InternalError:
      return {
        category: 'internal',
        title: 'Daemon internal error',
        hint: 'The daemon hit an unexpected condition. Check the daemon\'s log on the remote (`~/.obsidian-remote/server.log`) — the JSONL log line on the plugin side carries the call that triggered it.',
        original, code,
      };
  }
  return {
    category: 'unknown',
    title: err.message || 'Daemon error',
    hint: 'Daemon returned an error code outside the known taxonomy. Worth reporting; the JSONL log line carries the raw code + message.',
    original, code,
  };
}

function mapSyscallCode(code: string): { category: ErrorCategory; title: string; hint: string } | null {
  switch (code) {
    case 'ENOTFOUND':
      return {
        category: 'network',
        title: 'Host name lookup failed',
        hint: 'DNS couldn\'t resolve the remote\'s host. Check the profile\'s `host` field and `nslookup <host>` from the same machine.',
      };
    case 'ECONNREFUSED':
      return {
        category: 'network',
        title: 'Connection refused by the remote',
        hint: 'The remote answered but refused the connection. The SSH daemon may not be running, or it\'s on a different port — check the profile\'s `port`.',
      };
    case 'ECONNRESET':
      return {
        category: 'network',
        title: 'Connection reset by the remote',
        hint: 'The remote closed the SSH session unexpectedly. Often a sshd crash, an upstream load-balancer timeout, or a network blip.',
      };
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return {
        category: 'network',
        title: 'Network unreachable',
        hint: 'The remote isn\'t reachable from this machine right now. Check VPN / Wi-Fi / firewall / `ping <host>`.',
      };
    case 'ETIMEDOUT':
      return {
        category: 'timeout',
        title: 'Connection timed out',
        hint: 'The remote didn\'t respond in time. Check whether the host is reachable (ping / `ssh -v`) and whether a corporate firewall is throttling SSH.',
      };
    case 'EACCES':
    case 'EPERM':
      return {
        category: 'permission',
        title: 'Local permission denied',
        hint: 'The plugin couldn\'t read a local file (likely a private key or socket). Check filesystem permissions on the profile\'s `privateKeyPath` / `agentSocket`.',
      };
  }
  return null;
}


function readMaybeString(o: unknown, key: string): string | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Convenience wrapper: classify + format a single string suitable
 * for `new Notice(...)`. Title plus a separator dash plus hint.
 * Caller can still grab `.category` from the result if they want
 * to branch downstream (e.g. surface a "retry" button only for
 * network errors).
 */
export function classifyToNotice(err: unknown): { notice: string; classified: ClassifiedError } {
  const classified = classifyError(err);
  const notice = `Remote SSH: ${classified.title} — ${classified.hint}`;
  return { notice, classified };
}
