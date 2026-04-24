import * as crypto from 'crypto';

export interface LicensePayload {
  email: string;
  tier: 'pro';
  iat: number;
  exp: number;
  sub: string;
}

// Secret injected at build time via esbuild --define:HMAC_SECRET='"..."'
// Falls back to an empty string so free builds still compile
declare const HMAC_SECRET: string;
const SECRET = typeof HMAC_SECRET !== 'undefined' ? HMAC_SECRET : '';

export class LicenseValidator {
  static async validate(token: string): Promise<LicensePayload | null> {
    if (!token || !SECRET) return null;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [header, payload, sig] = parts;

      const expected = crypto
        .createHmac('sha256', SECRET)
        .update(`${header}.${payload}`)
        .digest('base64url');

      if (expected !== sig) return null;

      const data: LicensePayload = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf-8'),
      );

      if (!data.exp || data.exp < Date.now() / 1000) return null;
      if (data.tier !== 'pro') return null;

      return data;
    } catch {
      return null;
    }
  }

  static mint(payload: Omit<LicensePayload, 'iat'>, secret: string): string {
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body    = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const sig     = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }
}
