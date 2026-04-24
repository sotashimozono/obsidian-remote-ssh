import { describe, it, expect } from 'vitest';
import { LicenseValidator } from '../src/license/LicenseValidator';

const SECRET = 'test-secret-for-unit-tests';

function mint(payload: object, secret = SECRET): string {
  const { createHmac } = require('crypto');
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

// Patch the module-level SECRET via vi.stubGlobal so LicenseValidator uses our test secret
import { vi } from 'vitest';

describe('LicenseValidator.validate', () => {
  it('returns null for empty token', async () => {
    expect(await LicenseValidator.validate('')).toBeNull();
  });

  it('returns null for malformed token', async () => {
    expect(await LicenseValidator.validate('not.a.jwt')).toBeNull();
  });

  it('returns null for wrong number of segments', async () => {
    expect(await LicenseValidator.validate('only.two')).toBeNull();
  });
});

describe('LicenseValidator.mint', () => {
  it('produces a 3-part JWT string', () => {
    const token = LicenseValidator.mint(
      { email: 'test@example.com', tier: 'pro', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'user1' },
      SECRET,
    );
    expect(token.split('.')).toHaveLength(3);
  });

  it('minted token has correct payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = LicenseValidator.mint(
      { email: 'a@b.com', tier: 'pro', exp, sub: 'u' },
      SECRET,
    );
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.email).toBe('a@b.com');
    expect(payload.tier).toBe('pro');
    expect(payload.exp).toBe(exp);
    expect(payload.iat).toBeDefined();
  });
});
