import * as fs from 'fs';
import { BaseAgent, utils, type ParsedKey } from 'ssh2';
import {
  baseKeyType,
  certificateAlgorithm,
  isCertificateType,
  makeAgentKey,
  parsedKeySymbol,
  type AgentPublicKey,
} from './CertificateAgent';
import { isUsableIdentity, sshString } from './AgentIdentities';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * On-disk OpenSSH certificate authentication (companion to #536).
 *
 * `CertificateAgent` handles a certificate held by a running `ssh-agent`. But
 * the credential an organisation with a CA hands you is very often just two
 * files next to each other: a private key `id_ecdsa` and the certificate the
 * CA signed for it, `id_ecdsa-cert.pub`. OpenSSH's own `ssh` loads that
 * sibling automatically; ssh2 has no notion of it, and this plugin's
 * `privateKey` path used to read only the private key — so the certificate was
 * never presented and a CA-only server rejected the bare key ("All configured
 * authentication methods failed"), even though `ssh` to the same host worked.
 *
 * Rather than teach ssh2 about certificate files, this reuses the exact path a
 * certificate from the agent already travels: it presents the same
 * key-shaped object `CertificateAgent` presents (so `enableCertificateAuth`
 * finishes the handshake with the right algorithm names), but backs the
 * signature with the local private key instead of a socket round-trip. The
 * private key is parsed once, up front, and signs in-process.
 */

/** OpenSSH's convention: the certificate sits beside the key as `<key>-cert.pub`. */
export function certificateFilePath(privateKeyPath: string): string {
  return `${privateKeyPath}-cert.pub`;
}

/**
 * Build an agent that offers the on-disk certificate for `privateKeyPath` and
 * signs with the given private key. Returns `null` when no usable certificate
 * is found — either no `-cert.pub` beside the key, or one that is present but
 * unusable (unreadable, malformed, an `sk-*` type this can't sign for, or a
 * private key that won't parse).
 *
 * Never throws. A present-but-unusable certificate degrades to `null` with a
 * `warn`, so the caller falls back to bare-key auth — the credential OpenSSH
 * itself would still try, and which may well be authorised. The certificate is
 * additive: the caller offers the bare key too, so a rejected or expired cert
 * never costs a login the plain key would have won.
 */
export function loadDiskCertificate(
  privateKeyPath: string,
  privateKey: Buffer,
  passphrase?: string,
): DiskCertificateAgent | null {
  const certPath = certificateFilePath(privateKeyPath);
  if (!fs.existsSync(certPath)) return null;

  const skip = (why: string): null => {
    logger.warn(`DiskCertificate: skipping "${certPath}" (${why}); falling back to the bare key.`);
    return null;
  };

  try {
    const certText = fs.readFileSync(certPath, 'utf8');
    const { type, blob } = parseCertificateFile(certText, certPath);
    if (!isCertificateType(type)) {
      return skip(`not an OpenSSH certificate — type "${type}"`);
    }
    if (!isUsableIdentity(type)) {
      return skip(`unsupported ${baseKeyType(type)} certificate (FIDO sk-* not implemented)`);
    }
    // `isUsableIdentity` admits ssh-dss (the agent path can sign it, since the
    // agent frames its own signature), but local DSA signing here would need
    // the RFC 4253 §6.6 two-20-byte-integer reframing that `sshSignatureBody`
    // does not do — so we would advertise a DSS cert and then sign it wrong.
    // OpenSSH has disabled ssh-dss by default since 7.0, so rather than carry
    // dead framing for it, skip it and let the bare key (or another method)
    // proceed.
    if (baseKeyType(type) === 'ssh-dss') {
      return skip('ssh-dss certificates are not supported for on-disk signing (deprecated since OpenSSH 7.0)');
    }
    const parsed = utils.parseKey(privateKey, passphrase);
    if (parsed instanceof Error) {
      return skip(`cannot parse private key "${privateKeyPath}": ${parsed.message}`);
    }
    if (!parsed.isPrivateKey()) {
      return skip(`"${privateKeyPath}" is not a private key`);
    }
    return new DiskCertificateAgent(type, blob, parsed, certPath);
  } catch (e) {
    return skip(errorMessage(e));
  }
}

/**
 * Parse one line of an OpenSSH `*.pub` / `*-cert.pub` file:
 * `<type> <base64-blob> [comment]`. Returns the decoded blob (what goes on the
 * wire) and its type.
 *
 * The type is read from INSIDE the blob — its leading SSH string is the
 * algorithm name — not from the leading text token, which a hand-edited file
 * can leave disagreeing with the bytes. The agent path reads the type from the
 * blob for the same reason; trusting the token would let us advertise one
 * algorithm and sign under another, which the server rejects opaquely.
 */
function parseCertificateFile(text: string, certPath: string): { type: string; blob: Buffer } {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line) throw new Error(`certificate file "${certPath}" is empty`);
  const parts = line.split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`certificate file "${certPath}" is malformed (expected "<type> <base64>")`);
  }
  // `Buffer.from(_, 'base64')` never throws — it decodes leniently and drops
  // invalid characters — so a corrupt body is caught by the length/structure
  // checks below, not by a try/catch here.
  const blob = Buffer.from(parts[1], 'base64');
  const type = readBlobAlgorithm(blob, certPath);
  return { type, blob };
}

/** The algorithm name is the first SSH `string` in a public-key/certificate blob. */
function readBlobAlgorithm(blob: Buffer, certPath: string): string {
  if (blob.length < 4) throw new Error(`certificate file "${certPath}" has a truncated blob`);
  const len = blob.readUInt32BE(0);
  // A real algorithm name is short (e.g. `ecdsa-sha2-nistp256-cert-v01@openssh.com`);
  // an implausible length means the base64 body was not a key blob at all.
  if (len === 0 || len > 128 || 4 + len > blob.length) {
    throw new Error(`certificate file "${certPath}" has a malformed algorithm field`);
  }
  return blob.subarray(4, 4 + len).toString('utf8');
}

type SignCallback = (err: Error | null, signature?: Buffer) => void;

/**
 * An ssh2 `agent` that holds exactly one identity — the on-disk certificate —
 * and signs for it with the local private key.
 *
 * Mirrors `CertificateAgent`'s interface so `enableCertificateAuth` treats it
 * identically; the only difference is where the signature comes from. `sign`
 * returns a complete SSH signature blob (`string(algorithm) string(signature)`),
 * which is what `certificateAuth` expects for a certificate and what an agent
 * would have returned.
 */
export class DiskCertificateAgent extends BaseAgent<ParsedKey> {
  constructor(
    private readonly certType: string,
    private readonly certBlob: Buffer,
    private readonly privateKey: ParsedKey,
    private readonly certPath: string,
  ) {
    super();
  }

  getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void): void {
    const marker = parsedKeySymbol();
    if (!marker) {
      cb(new Error('Cannot offer the certificate: ssh2 internals changed'));
      return;
    }
    // Named for the wire, exactly as CertificateAgent does: an RSA certificate
    // must be advertised under its SHA-2 name or the server refuses the probe.
    const wireType = certificateAlgorithm(this.certType);
    logger.info(`DiskCertificateAgent: offering certificate ${this.certPath} (${wireType})`);
    cb(undefined, [
      makeAgentKey(wireType, this.certPath, this.certBlob, marker) as unknown as ParsedKey,
    ]);
  }

  sign(pubKey: ParsedKey, data: Buffer, options: unknown, cb?: unknown): void {
    const callback = (typeof options === 'function' ? options : cb) as SignCallback | undefined;
    if (!callback) {
      // ssh2 always passes one today; guard the same way CertificateAgent does
      // so a future change surfaces as a log line rather than a silent hang.
      logger.warn('DiskCertificateAgent.sign called with no callback; ignoring the request');
      return;
    }

    // `pubKey.type` is the wire name from getIdentities (SHA-2 for RSA); the
    // base algorithm is what actually signs and what the SSH signature blob
    // must name.
    const wireType = (pubKey as unknown as AgentPublicKey).type;
    const base = baseKeyType(wireType);

    let raw: Buffer | Error;
    try {
      raw = this.privateKey.sign(data, hashAlgorithm(base));
    } catch (e) {
      callback(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (raw instanceof Error) {
      callback(raw);
      return;
    }

    try {
      callback(null, Buffer.concat([sshString(base), sshString(sshSignatureBody(raw, base))]));
    } catch (e) {
      callback(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/**
 * The digest ssh2's key signer must use for each base algorithm.
 *
 * Ed25519 takes none (Node's `crypto.sign` rejects a hash for it). RSA must be
 * SHA-512 — the base type is renamed to `rsa-sha2-512` for the wire, so the
 * signature has to actually be SHA-512 or the server's `sshkey_check_sigtype`
 * rejects it. ECDSA's digest is fixed by its curve.
 *
 * An unrecognised algorithm throws rather than defaulting to "no digest": the
 * only caller (`sign`) wraps this and reports the error, so a type that slips
 * past `loadDiskCertificate`'s filters fails loudly instead of silently
 * producing an unverifiable signature.
 */
function hashAlgorithm(base: string): string | undefined {
  switch (base) {
    case 'ssh-ed25519': return undefined;
    case 'ssh-rsa':
    case 'rsa-sha2-512': return 'sha512';
    case 'ecdsa-sha2-nistp256': return 'sha256';
    case 'ecdsa-sha2-nistp384': return 'sha384';
    case 'ecdsa-sha2-nistp521': return 'sha512';
    default: throw new Error(`no signing digest defined for algorithm "${base}"`);
  }
}

/**
 * The signature body that goes inside the SSH signature blob.
 *
 * RSA and Ed25519 use the raw bytes the signer produces. ECDSA does not: Node
 * emits an ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }`, but SSH wants
 * `string(r) string(s)`. DER's minimal big-endian two's-complement integer
 * encoding (with a leading `0x00` when the high bit is set) is exactly SSH's
 * mpint rule, so the integer bytes copy across unchanged — only the framing
 * differs. This mirrors ssh2's own `convertSignature`.
 */
export function sshSignatureBody(raw: Buffer, base: string): Buffer {
  if (!base.startsWith('ecdsa-')) return raw;
  const { r, s } = parseDerEcdsaSignature(raw);
  return Buffer.concat([sshString(r), sshString(s)]);
}

/** Read one ASN.1/DER length: short form (`0..0x7f`) or long form (`0x8N` + N bytes). */
function readDerLength(der: Buffer, pos: number): { length: number; next: number } {
  const first = der[pos];
  if (first === undefined) throw new Error('malformed ECDSA signature (truncated length)');
  if (first < 0x80) return { length: first, next: pos + 1 };
  const byteCount = first & 0x7f;
  if (byteCount === 0 || byteCount > 4) {
    throw new Error(`malformed ECDSA signature (unsupported length form 0x${first.toString(16)})`);
  }
  let length = 0;
  for (let i = 0; i < byteCount; i++) {
    const b = der[pos + 1 + i];
    if (b === undefined) throw new Error('malformed ECDSA signature (truncated long-form length)');
    length = (length << 8) | b;
  }
  return { length, next: pos + 1 + byteCount };
}

/** Read one DER INTEGER (tag `0x02`) and return its raw content bytes. */
function readDerInteger(der: Buffer, pos: number): { value: Buffer; next: number } {
  if (der[pos] !== 0x02) throw new Error('malformed ECDSA signature (expected INTEGER)');
  const { length, next } = readDerLength(der, pos + 1);
  const end = next + length;
  if (end > der.length) throw new Error('malformed ECDSA signature (INTEGER overruns buffer)');
  return { value: der.subarray(next, end), next: end };
}

/** Parse `SEQUENCE { INTEGER r, INTEGER s }` from a Node/OpenSSL ECDSA signature. */
function parseDerEcdsaSignature(der: Buffer): { r: Buffer; s: Buffer } {
  if (der[0] !== 0x30) throw new Error('malformed ECDSA signature (expected SEQUENCE)');
  const { next } = readDerLength(der, 1);
  const first = readDerInteger(der, next);
  const second = readDerInteger(der, first.next);
  return { r: first.value, s: second.value };
}
