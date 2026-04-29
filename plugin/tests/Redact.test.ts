import { describe, it, expect } from 'vitest';
import { redactString, redactFields, SECRET_KEY_HINTS } from '../src/util/redact';

describe('redactString — token-shape detection', () => {
  it('passes a clean message through untouched', () => {
    expect(redactString('connected to host')).toBe('connected to host');
  });

  it('redacts a 32-char hex token (e.g. server.deploy session token)', () => {
    const tok = 'deadbeefcafef00d1234567890abcdef';
    const got = redactString(`token=${tok} accepted`);
    expect(got).toBe('token=<REDACTED:32b> accepted');
  });

  it('redacts a 64-char hex (e.g. sha256 sum)', () => {
    const sha = 'a'.repeat(64);
    expect(redactString(sha)).toBe('<REDACTED:64b>');
  });

  it('does NOT redact a short hex (under 32 chars)', () => {
    expect(redactString('mtime=1700000000ab')).toBe('mtime=1700000000ab');
  });

  it('redacts a JWT-shaped token in a sentence', () => {
    // Three base64url segments, each ≥16 chars, separated by dots.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEyMzQ1Njc4OTB9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactString(`bearer ${jwt} ok`)).toMatch(/^bearer <REDACTED:\d+b> ok$/);
  });

  it('redacts a long base64-shaped string (e.g. private key body)', () => {
    const blob = 'A'.repeat(80);
    expect(redactString(`key: ${blob}`)).toBe('key: <REDACTED:80b>');
  });

  it('does NOT redact a short base64 (e.g. content payload fixture)', () => {
    expect(redactString('content=aGVsbG8=')).toBe('content=aGVsbG8=');
  });

  it('redacts MULTIPLE token-shaped substrings independently', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(redactString(`first ${a} then ${b}`)).toBe(`first <REDACTED:40b> then <REDACTED:40b>`);
  });
});

describe('redactFields — key-name + value scan', () => {
  it('redacts values whose key name contains a secret-hint word', () => {
    const out = redactFields({ password: 'p@ss', userName: 'alice' });
    expect(out).toEqual({ password: '<REDACTED>', userName: 'alice' });
  });

  it('matches secret hints case-insensitively (Token / TOKEN / authToken)', () => {
    const out = redactFields({ Token: 'a', authToken: 'b', TOKEN: 'c' });
    expect(out).toEqual({ Token: '<REDACTED>', authToken: '<REDACTED>', TOKEN: '<REDACTED>' });
  });

  it('matches snake_case keys (api_key, refresh_token)', () => {
    const out = redactFields({ api_key: 'a', refresh_token: 'b' });
    expect(out).toEqual({ api_key: '<REDACTED>', refresh_token: '<REDACTED>' });
  });

  it('runs redactString over non-secret string values too', () => {
    const tok = 'deadbeefcafe1234deadbeefcafe1234';
    const out = redactFields({ url: `https://x/?t=${tok}` });
    expect(out.url).toBe(`https://x/?t=<REDACTED:32b>`);
  });

  it('preserves non-string values for non-secret keys', () => {
    const out = redactFields({ count: 42, ok: true, nothing: null });
    expect(out).toEqual({ count: 42, ok: true, nothing: null });
  });

  it('recurses into nested plain objects and applies key-name redaction at each level', () => {
    const out = redactFields({
      profile: { host: '157.x.y.z', token: 'sekrit' },
      meta: { ok: true },
    });
    expect(out).toEqual({
      profile: { host: '157.x.y.z', token: '<REDACTED>' },
      meta: { ok: true },
    });
  });

  it('walks arrays element-wise', () => {
    const out = redactFields({
      events: [{ name: 'connect', token: 'sekrit' }, { name: 'idle' }],
    });
    expect(out).toEqual({
      events: [{ name: 'connect', token: '<REDACTED>' }, { name: 'idle' }],
    });
  });

  it('returns a new object even when nothing was redacted', () => {
    const input = { a: 1, b: 'two' };
    const out = redactFields(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
});

describe('SECRET_KEY_HINTS', () => {
  it('is frozen to prevent silent mutation', () => {
    expect(Object.isFrozen(SECRET_KEY_HINTS)).toBe(true);
  });

  it('includes the headline credential names', () => {
    for (const name of ['password', 'token', 'secret', 'private_key']) {
      expect(SECRET_KEY_HINTS).toContain(name);
    }
  });
});
