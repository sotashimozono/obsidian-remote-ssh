import { describe, it, expect } from 'vitest';
import { classifyError, classifyToNotice, type ErrorCategory } from '../src/transport/errorTaxonomy';
import { RpcError } from '../src/transport/RpcError';
import { ErrorCode } from '../src/proto/types';

/**
 * Pins the F18 error taxonomy: every known RpcError code, every
 * well-known ssh2 / Node syscall code, and the message-pattern
 * fallbacks must classify into a stable category with a non-empty
 * title + hint. The 'unknown' category is the catch-all and must
 * preserve the original error message in its title so the user
 * still sees something useful.
 */

// ── helper to assert the contract every classified error must satisfy ──

function assertWellFormed(c: ReturnType<typeof classifyError>) {
  expect(c.title).toBeTruthy();
  expect(c.hint).toBeTruthy();
  expect(c.original).toBeInstanceOf(Error);
  expect(c.title.length).toBeLessThan(120); // suitable for new Notice(title)
  expect(c.hint.length).toBeGreaterThan(20); // hint should actually advise
}

// ── RpcError → category ────────────────────────────────────────────────

describe('classifyError — RpcError taxonomy', () => {
  const cases: Array<{ code: number; cat: ErrorCategory }> = [
    { code: ErrorCode.AuthRequired,          cat: 'auth' },
    { code: ErrorCode.AuthInvalid,           cat: 'auth' },
    { code: ErrorCode.FileNotFound,          cat: 'not-found' },
    { code: ErrorCode.NotADirectory,         cat: 'wrong-kind' },
    { code: ErrorCode.IsADirectory,          cat: 'wrong-kind' },
    { code: ErrorCode.Exists,                cat: 'wrong-kind' },
    { code: ErrorCode.PermissionDenied,      cat: 'permission' },
    { code: ErrorCode.PathOutsideVault,      cat: 'sandbox' },
    { code: ErrorCode.PreconditionFailed,    cat: 'precondition' },
    { code: ErrorCode.ProtocolVersionTooOld, cat: 'protocol' },
    { code: ErrorCode.ParseError,            cat: 'protocol' },
    { code: ErrorCode.InvalidRequest,        cat: 'protocol' },
    { code: ErrorCode.MethodNotFound,        cat: 'protocol' },
    { code: ErrorCode.InvalidParams,         cat: 'protocol' },
    { code: ErrorCode.InternalError,         cat: 'internal' },
  ];

  for (const { code, cat } of cases) {
    it(`code ${code} → '${cat}'`, () => {
      const c = classifyError(new RpcError(code, 'test'));
      expect(c.category).toBe(cat);
      expect(c.code).toBe(code);
      assertWellFormed(c);
    });
  }

  it('unknown RpcError code falls back to "unknown" but echoes the message', () => {
    const c = classifyError(new RpcError(-999, 'mystery'));
    expect(c.category).toBe('unknown');
    expect(c.title).toBe('mystery');
    expect(c.code).toBe(-999);
  });
});

// ── ssh2 errors ────────────────────────────────────────────────────────

describe('classifyError — ssh2 layer', () => {
  it('client-authentication level → "auth"', () => {
    const e = new Error('All configured authentication methods failed');
    (e as Error & { level: string }).level = 'client-authentication';
    const c = classifyError(e);
    expect(c.category).toBe('auth');
    expect(c.title).toMatch(/authentication failed/i);
    assertWellFormed(c);
  });

  it('protocol level → "protocol"', () => {
    const e = new Error('Protocol mismatch');
    (e as Error & { level: string }).level = 'protocol';
    const c = classifyError(e);
    expect(c.category).toBe('protocol');
    assertWellFormed(c);
  });
});

// ── Node syscall codes ────────────────────────────────────────────────

describe('classifyError — Node syscall codes', () => {
  const cases: Array<{ syscode: string; cat: ErrorCategory }> = [
    { syscode: 'ENOTFOUND',    cat: 'network' },
    { syscode: 'ECONNREFUSED', cat: 'network' },
    { syscode: 'ECONNRESET',   cat: 'network' },
    { syscode: 'ENETUNREACH',  cat: 'network' },
    { syscode: 'EHOSTUNREACH', cat: 'network' },
    { syscode: 'ETIMEDOUT',    cat: 'timeout' },
    { syscode: 'EACCES',       cat: 'permission' },
    { syscode: 'EPERM',        cat: 'permission' },
  ];

  for (const { syscode, cat } of cases) {
    it(`code ${syscode} → '${cat}'`, () => {
      const e = new Error(`some ${syscode} error`);
      (e as Error & { code: string }).code = syscode;
      const c = classifyError(e);
      expect(c.category).toBe(cat);
      expect(c.code).toBe(syscode);
      assertWellFormed(c);
    });
  }
});

// ── message-pattern fallbacks ─────────────────────────────────────────

describe('classifyError — message fallbacks', () => {
  it('"Host key fingerprint mismatch" → "host-key"', () => {
    const c = classifyError(new Error('Host key fingerprint mismatch — refusing to connect'));
    expect(c.category).toBe('host-key');
    assertWellFormed(c);
  });

  it('"timed out" message without an error code → "timeout"', () => {
    const c = classifyError(new Error('Connect attempt timed out after 30s'));
    expect(c.category).toBe('timeout');
    assertWellFormed(c);
  });

  it('plain Error with no special markers → "unknown" (echoes message)', () => {
    const c = classifyError(new Error('something weird happened'));
    expect(c.category).toBe('unknown');
    expect(c.title).toBe('something weird happened');
    assertWellFormed(c);
  });

  it('thrown non-Error (string) is wrapped — no crash', () => {
    const c = classifyError('boom');
    expect(c.category).toBe('unknown');
    expect(c.original).toBeInstanceOf(Error);
    expect(c.original.message).toBe('boom');
  });
});

// ── classifyToNotice convenience ──────────────────────────────────────

describe('classifyToNotice', () => {
  it('produces a "Remote SSH: <title> — <hint>" string + the classified payload', () => {
    const { notice, classified } = classifyToNotice(new RpcError(ErrorCode.PreconditionFailed, 'mtime drift'));
    expect(notice).toMatch(/^Remote SSH: Write conflict — file changed remotely/);
    expect(notice).toContain('—');
    expect(classified.category).toBe('precondition');
  });
});
