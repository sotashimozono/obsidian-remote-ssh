import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { utils, type ParsedKey } from 'ssh2';
import {
  certificateFilePath,
  loadDiskCertificate,
  sshSignatureBody,
  type DiskCertificateAgent,
} from '../src/ssh/DiskCertificate';
import type { AgentPublicKey } from '../src/ssh/CertificateAgent';

/**
 * On-disk certificate auth (#536 companion). The load-bearing property is that
 * the signature this produces from a local private key verifies against that
 * key's public half — i.e. it is a real, correctly SSH-framed signature — and
 * that the certificate is offered under the right wire name (SHA-2 for RSA).
 */

// ─── pure logic (always runs) ───────────────────────────────────────────

describe('certificateFilePath', () => {
  it('is the OpenSSH sibling of the private key', () => {
    expect(certificateFilePath('/home/u/.ssh/id_ecdsa')).toBe('/home/u/.ssh/id_ecdsa-cert.pub');
    expect(certificateFilePath('C:\\Users\\u\\.ssh\\id_rsa')).toBe('C:\\Users\\u\\.ssh\\id_rsa-cert.pub');
  });
});

describe('loadDiskCertificate without a sibling certificate', () => {
  it('returns null so ordinary key auth is left untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orst-nocert-'));
    try {
      const keyPath = path.join(dir, 'id_ed25519');
      fs.writeFileSync(keyPath, 'unused');
      expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back (returns null) when the sibling is a plain public key, not a certificate', () => {
    // The type is read from inside the blob: `AAAAC3NzaC1lZDI1NTE5` decodes to
    // the SSH string "ssh-ed25519" — a key, not a certificate. Degrade to the
    // bare key rather than break a connection that key would complete.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orst-plainpub-'));
    try {
      const keyPath = path.join(dir, 'id_ed25519');
      fs.writeFileSync(keyPath, 'unused');
      fs.writeFileSync(`${keyPath}-cert.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 comment\n');
      expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back (returns null) on a corrupt certificate blob', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orst-corrupt-'));
    try {
      const keyPath = path.join(dir, 'id_ed25519');
      fs.writeFileSync(keyPath, 'unused');
      // Garbage body: decodes to too few bytes to hold an algorithm string.
      fs.writeFileSync(`${keyPath}-cert.pub`, 'ssh-ed25519-cert-v01@openssh.com AA x\n');
      expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back (returns null) on an ssh-dss certificate — no local DSA framing', () => {
    // ssh-dss passes isUsableIdentity (the agent path can sign it) but this
    // local signer does not do DSA's RFC 4253 §6.6 reframing, so it must be
    // skipped rather than signed wrong. Build a blob whose leading SSH string
    // is the DSS cert type; the body past it is irrelevant to this check.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orst-dss-'));
    try {
      const keyPath = path.join(dir, 'id_dsa');
      fs.writeFileSync(keyPath, 'unused');
      const algo = 'ssh-dss-cert-v01@openssh.com';
      const len = Buffer.alloc(4);
      len.writeUInt32BE(algo.length, 0);
      const blob = Buffer.concat([len, Buffer.from(algo), Buffer.from('trailing-cert-bytes')]);
      fs.writeFileSync(`${keyPath}-cert.pub`, `${algo} ${blob.toString('base64')} comment\n`);
      expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sshSignatureBody', () => {
  it('passes RSA and Ed25519 signatures through unchanged', () => {
    const raw = Buffer.from([1, 2, 3, 4, 5]);
    expect(sshSignatureBody(raw, 'ssh-ed25519').equals(raw)).toBe(true);
    expect(sshSignatureBody(raw, 'rsa-sha2-512').equals(raw)).toBe(true);
  });

  it('reframes a DER ECDSA signature into SSH string(r) string(s)', () => {
    // SEQUENCE { INTEGER 0x01, INTEGER 0x00FF } — 0x00FF keeps its sign byte.
    const der = Buffer.from([0x30, 0x08, 0x02, 0x01, 0x01, 0x02, 0x02, 0x00, 0xff]);
    const body = sshSignatureBody(der, 'ecdsa-sha2-nistp256');
    expect(body.equals(Buffer.from([
      0x00, 0x00, 0x00, 0x01, 0x01,             // string r = 0x01
      0x00, 0x00, 0x00, 0x02, 0x00, 0xff,       // string s = 0x00 0xff
    ]))).toBe(true);
  });

  it('rejects a malformed ECDSA signature rather than emitting garbage', () => {
    expect(() => sshSignatureBody(Buffer.from([0x02, 0x01, 0x01]), 'ecdsa-sha2-nistp256'))
      .toThrow(/SEQUENCE/);
  });
});

// ─── real crypto (needs ssh-keygen) ───────────────────────────────────────

function have(cmd: string, args: string[]): boolean {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).error === undefined; }
  catch { return false; }
}
const HAS_KEYGEN = have('ssh-keygen', ['-?']);
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

/** Promise wrappers around the callback agent API. */
function identities(a: DiskCertificateAgent): Promise<AgentPublicKey[]> {
  return new Promise((resolve, reject) =>
    a.getIdentities((err, keys) => err ? reject(err) : resolve(keys as unknown as AgentPublicKey[])));
}
function sign(a: DiskCertificateAgent, key: AgentPublicKey, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    a.sign(key as never, data, {}, (err: Error | null, sig?: Buffer) =>
      err ? reject(err) : resolve(sig!)));
}

/** Read one SSH `string`, returning its bytes and the next offset. */
function readSshString(buf: Buffer, pos: number): { value: Buffer; next: number } {
  const len = buf.readUInt32BE(pos);
  return { value: buf.subarray(pos + 4, pos + 4 + len), next: pos + 4 + len };
}

/** Rebuild a DER `SEQUENCE { INTEGER r, INTEGER s }` from SSH-framed r/s. */
function rsToDer(body: Buffer): Buffer {
  const r = readSshString(body, 0);
  const s = readSshString(body, r.next);
  const int = (b: Buffer) => Buffer.concat([Buffer.from([0x02, b.length]), b]);
  const seq = Buffer.concat([int(r.value), int(s.value)]);
  const header = seq.length < 0x80
    ? Buffer.from([0x30, seq.length])
    : Buffer.from([0x30, 0x81, seq.length]);
  return Buffer.concat([header, seq]);
}

/**
 * Verify the blob the agent returned against the private key's public half,
 * proving it is a genuine signature over `data`, correctly SSH-framed.
 */
function verifyAgentSignature(privPath: string, base: string, data: Buffer, blob: Buffer): boolean {
  const algo = readSshString(blob, 0);
  expect(algo.value.toString('utf8')).toBe(base);
  const body = readSshString(blob, algo.next).value;

  const parsed = utils.parseKey(fs.readFileSync(privPath)) as ParsedKey;
  const pub = crypto.createPublicKey(parsed.getPublicPEM());

  if (base === 'ssh-ed25519') return crypto.verify(null, data, pub, body);
  if (base === 'rsa-sha2-512') return crypto.verify('sha512', data, pub, body);
  const hash = base.endsWith('521') ? 'sha512' : base.endsWith('384') ? 'sha384' : 'sha256';
  return crypto.verify(hash, data, pub, rsToDer(body));
}

interface CertCase { label: string; keygenType: string[]; base: string; wire: string }
const CASES: CertCase[] = [
  { label: 'Ed25519', keygenType: ['-t', 'ed25519'], base: 'ssh-ed25519', wire: 'ssh-ed25519-cert-v01@openssh.com' },
  { label: 'ECDSA', keygenType: ['-t', 'ecdsa', '-b', '256'], base: 'ecdsa-sha2-nistp256', wire: 'ecdsa-sha2-nistp256-cert-v01@openssh.com' },
  // An agent lists an RSA cert as ssh-rsa-cert...; it must go on the wire as
  // its SHA-2 name, and the signature must actually be SHA-512.
  { label: 'RSA', keygenType: ['-t', 'rsa', '-b', '2048'], base: 'rsa-sha2-512', wire: 'rsa-sha2-512-cert-v01@openssh.com' },
];

describe.skipIf(!HAS_KEYGEN)('loadDiskCertificate with a real key + certificate', () => {
  let dir = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orst-diskcert-'));
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-f', path.join(dir, 'ca'), '-N', '', '-C', 'ca']);
    for (const c of CASES) {
      const id = path.join(dir, `id-${c.label}`);
      run('ssh-keygen', ['-q', ...c.keygenType, '-f', id, '-N', '', '-C', `user-${c.label}`]);
      run('ssh-keygen', ['-q', '-s', path.join(dir, 'ca'), '-I', c.label, '-n', 'tester', '-V', '+1h', `${id}.pub`]);
    }
  }, 60_000);
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  for (const c of CASES) {
    it(`offers the ${c.label} certificate under its wire name and signs verifiably`, async () => {
      const id = path.join(dir, `id-${c.label}`);
      const agent = loadDiskCertificate(id, fs.readFileSync(id));
      expect(agent, 'a sibling -cert.pub was found').not.toBeNull();

      const [key] = await identities(agent!);
      expect(key.type).toBe(c.wire);
      expect(key.getPublicSSH().length).toBeGreaterThan(0);

      const data = Buffer.from('the bytes the server will verify');
      const blob = await sign(agent!, key, data);
      expect(verifyAgentSignature(id, c.base, data, blob), 'signature verifies').toBe(true);

      // A different message must not verify — guards against a no-op signer.
      expect(verifyAgentSignature(id, c.base, Buffer.from('other'), blob)).toBe(false);
    });
  }

  it('falls back (returns null) when the private key beside a real cert will not parse', () => {
    const id = path.join(dir, 'id-Ed25519');
    // A valid cert, but the key is garbage: degrade to bare-key auth (which
    // ssh2 will then reject on its own) rather than throw from buildAuthConfig.
    fs.writeFileSync(path.join(dir, 'broken'), 'not a key');
    fs.copyFileSync(`${id}-cert.pub`, path.join(dir, 'broken-cert.pub'));
    expect(loadDiskCertificate(path.join(dir, 'broken'), Buffer.from('not a key'))).toBeNull();
  });
});
