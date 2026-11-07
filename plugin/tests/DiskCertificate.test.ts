import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
  DiskCertificateAgent,
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

  it('refuses a length field too wide to be a signature', () => {
    // 0x85 claims five length bytes. Real ECDSA signatures need one or two, so
    // anything wider is a corrupt buffer, not a big number — and reading it
    // would shift every subsequent offset.
    expect(() => sshSignatureBody(Buffer.from([0x30, 0x85, 1, 2, 3, 4, 5]), 'ecdsa-sha2-nistp521'))
      .toThrow(/unsupported length form/);
  });

  it('refuses a long-form length that runs off the end', () => {
    // 0x82 promises two length bytes and only one follows. Without the bounds
    // check the missing byte reads as undefined and the length silently
    // becomes NaN.
    expect(() => sshSignatureBody(Buffer.from([0x30, 0x82, 0x01]), 'ecdsa-sha2-nistp521'))
      .toThrow(/truncated long-form length/);
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
  // P-384 and P-521 are not ceremony. Their digests are the two
  // `hashAlgorithm` arms nothing reached, and P-521's r and s are 66 bytes
  // each, so the DER SEQUENCE runs past 127 bytes and the signature can only
  // be parsed through `readDerLength`'s long-form branch — which nothing
  // reached either. Getting that wrong breaks P-521 certificates and nothing
  // else, which is the kind of gap that ships.
  { label: 'ECDSA384', keygenType: ['-t', 'ecdsa', '-b', '384'], base: 'ecdsa-sha2-nistp384', wire: 'ecdsa-sha2-nistp384-cert-v01@openssh.com' },
  { label: 'ECDSA521', keygenType: ['-t', 'ecdsa', '-b', '521'], base: 'ecdsa-sha2-nistp521', wire: 'ecdsa-sha2-nistp521-cert-v01@openssh.com' },
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

  it('refuses an ssh-dss certificate even when the key beside it is perfectly good', () => {
    // The guard has to be the reason for the null. An earlier version of this
    // handed over an unparseable key, so the fallback happened anyway and the
    // test passed with the guard deleted — it pinned nothing.
    const keyPath = path.join(dir, 'dss-key');
    fs.copyFileSync(path.join(dir, 'id-Ed25519'), keyPath);
    writeCertBlobFor(keyPath, 'ssh-dss-cert-v01@openssh.com');

    expect(loadDiskCertificate(keyPath, fs.readFileSync(keyPath))).toBeNull();
  });

  it('falls back when what sits beside the certificate is the public half', () => {
    // A `.pub` parses fine; it just cannot sign. Without the isPrivateKey check
    // the agent would be built and every signature attempt would fail later,
    // mid-handshake, instead of falling back to the bare key now.
    const id = path.join(dir, 'id-Ed25519');
    const pubOnly = path.join(dir, 'pub-only');
    fs.copyFileSync(`${id}.pub`, pubOnly);
    fs.copyFileSync(`${id}-cert.pub`, `${pubOnly}-cert.pub`);

    expect(loadDiskCertificate(pubOnly, fs.readFileSync(pubOnly))).toBeNull();
  });

  it('falls back (returns null) when the private key beside a real cert will not parse', () => {
    const id = path.join(dir, 'id-Ed25519');
    // A valid cert, but the key is garbage: degrade to bare-key auth (which
    // ssh2 will then reject on its own) rather than throw from buildAuthConfig.
    fs.writeFileSync(path.join(dir, 'broken'), 'not a key');
    fs.copyFileSync(`${id}-cert.pub`, path.join(dir, 'broken-cert.pub'));
    expect(loadDiskCertificate(path.join(dir, 'broken'), Buffer.from('not a key'))).toBeNull();
  });
});

/** A cert file whose blob announces `algo`; the bytes past it do not matter here. */
function writeCertBlobFor(keyPath: string, algo: string): void {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(algo.length, 0);
  const blob = Buffer.concat([len, Buffer.from(algo), Buffer.from('trailing-cert-bytes')]);
  fs.writeFileSync(`${keyPath}-cert.pub`, `${algo} ${blob.toString('base64')} comment\n`);
}

describe('loadDiskCertificate — why it falls back', () => {
  // Each of these is a distinct reason the user's certificate is ignored, and
  // each ends the same way: a warning, and the bare key offered instead. None
  // of them was executed.
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orst-fallback-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('will not try to sign for a FIDO security key', () => {
    // sk-* certificates need the token present and a different signing flow.
    const keyPath = path.join(dir, 'id_sk');
    fs.writeFileSync(keyPath, 'unused');
    writeCertBlobFor(keyPath, 'sk-ssh-ed25519-cert-v01@openssh.com');

    expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
  });

  it('survives a certificate file that is not "<type> <base64>"', () => {
    // A hand-edited or truncated file must degrade to the bare key, not throw
    // out of buildAuthConfig and take the whole connection with it.
    const keyPath = path.join(dir, 'id_bad');
    fs.writeFileSync(keyPath, 'unused');
    fs.writeFileSync(`${keyPath}-cert.pub`, 'only-one-token\n');

    expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
  });

  it('survives a base64 body that is not a key blob', () => {
    // Decodes fine — `Buffer.from(_, 'base64')` never throws — but the leading
    // SSH string length is nonsense, so the bytes are not a certificate.
    const keyPath = path.join(dir, 'id_garbage');
    fs.writeFileSync(keyPath, 'unused');
    const notABlob = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01]);
    fs.writeFileSync(
      `${keyPath}-cert.pub`,
      `ssh-ed25519-cert-v01@openssh.com ${notABlob.toString('base64')} comment\n`,
    );

    expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
  });

  it('returns null, quietly, when there is no sibling certificate at all', () => {
    const keyPath = path.join(dir, 'id_plain');
    fs.writeFileSync(keyPath, 'unused');

    expect(loadDiskCertificate(keyPath, Buffer.from('unused'))).toBeNull();
  });
});

describe('DiskCertificateAgent.sign — when signing cannot be done', () => {
  // The failure paths all end in the same place: the callback gets an Error, so
  // ssh2 moves on to the next auth method. Reporting nothing, or reporting a
  // half-built signature, would fail the handshake with no explanation.
  const agentSigning = (impl: () => Buffer | Error, certType = 'ecdsa-sha2-nistp256-cert-v01@openssh.com') =>
    new DiskCertificateAgent(
      certType,
      Buffer.from('cert-blob'),
      { sign: impl } as unknown as ParsedKey,
      '/tmp/id-cert.pub',
    );
  const offered = (type: string) => ({ type } as unknown as AgentPublicKey);

  it('reports an algorithm it has no digest for, rather than signing without one', async () => {
    const type = 'ssh-unknown-cert-v01@openssh.com';
    const agent = agentSigning(() => Buffer.alloc(0), type);

    await expect(sign(agent, offered(type), Buffer.from('x')))
      .rejects.toThrow(/no signing digest defined/);
  });

  it('hands the signer\'s own error to the caller', async () => {
    const agent = agentSigning(() => new Error('key is locked'));

    await expect(sign(agent, offered('ecdsa-sha2-nistp256-cert-v01@openssh.com'), Buffer.from('x')))
      .rejects.toThrow(/key is locked/);
  });

  it('reports a signature it cannot reframe instead of sending it anyway', async () => {
    // ECDSA has to be reframed from DER. Bytes that are not DER must fail here,
    // because the alternative is a signature the server rejects opaquely.
    const agent = agentSigning(() => Buffer.from([1, 2, 3]));

    await expect(sign(agent, offered('ecdsa-sha2-nistp256-cert-v01@openssh.com'), Buffer.from('x')))
      .rejects.toThrow(/SEQUENCE/);
  });

  it('does nothing, and does not throw, if ssh2 ever passes no callback', () => {
    const agent = agentSigning(() => Buffer.from([1]));

    expect(() => agent.sign(
      offered('ecdsa-sha2-nistp256-cert-v01@openssh.com') as never,
      Buffer.from('x'), undefined, undefined,
    )).not.toThrow();
  });
});
