#!/usr/bin/env node
/**
 * Mint a Pro license key (JWT HS256).
 *
 * Usage:
 *   HMAC_SECRET=<secret> node scripts/mint-license.mjs <email> [github-username] [days]
 *
 * Output:
 *   JWT token (print to stdout, redirect to clipboard or email)
 *
 * Examples:
 *   HMAC_SECRET=mysecret node scripts/mint-license.mjs sponsor@example.com gh-user 365
 *   HMAC_SECRET=mysecret node scripts/mint-license.mjs sponsor@example.com          # 365 days default
 */

import { createHmac } from 'crypto';

const [,, email, sub = '', daysStr = '365'] = process.argv;

if (!email) {
  console.error('Usage: HMAC_SECRET=<secret> node scripts/mint-license.mjs <email> [github-username] [days]');
  process.exit(1);
}

const secret = process.env.HMAC_SECRET;
if (!secret) {
  console.error('Error: HMAC_SECRET env var is not set');
  process.exit(1);
}

const days  = parseInt(daysStr, 10);
const now   = Math.floor(Date.now() / 1000);
const exp   = now + days * 86400;

const payload = { email, tier: 'pro', iat: now, exp, sub: sub || email };

const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const body    = b64url(JSON.stringify(payload));
const sig     = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
const token   = `${header}.${body}.${sig}`;

console.log(token);
console.error(`\nMinted Pro license for ${email} (expires ${new Date(exp * 1000).toISOString().slice(0, 10)})`);

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}
