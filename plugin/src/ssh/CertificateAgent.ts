import { BaseAgent, utils, type ParsedKey } from 'ssh2';
import {
  agentRoundTrip,
  baseKeyType,
  SIGN_TIMEOUT_MS,
  isCertificateType,
  isUsableIdentity,
  listAgentIdentityBlobs,
  sshString,
  type AgentQueryOptions,
} from './AgentIdentities';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * An `ssh-agent` client that does not throw away what it cannot parse (#536).
 *
 * ssh2's own agent support runs every identity through `parseKey()` and skips
 * the failures silently, which loses OpenSSH certificates — the credential an
 * organisation with a CA actually issues. This one keeps every identity the
 * agent offers and hands ssh2 a key-shaped object for each, so a certificate
 * reaches the server like any other public key.
 *
 * The private key never leaves the agent: signing is a SIGN_REQUEST quoting
 * the identity's blob, exactly as OpenSSH's own client does.
 *
 * A certificate additionally needs `enableCertificateAuth()` on the client —
 * ssh2 writes the wrong algorithm name into the signature otherwise. See
 * `certificateAuth.ts`.
 */

const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;
const SSH_AGENT_FAILURE = 5;
/** Signature flags from PROTOCOL.agent; only RSA has any. */
const SSH_AGENT_RSA_SHA2_256 = 2;
const SSH_AGENT_RSA_SHA2_512 = 4;

/** ssh2's `createAgent` handles Pageant and Cygwin sockets itself. */
const WINDOWS_PIPE = /^[/\\][/\\]\.[/\\]pipe[/\\].+/;

/**
 * True when we can speak to this agent ourselves. On Windows a path that is
 * not a named pipe means Pageant or a Cygwin socket, both of which have their
 * own framing — leave those to ssh2 rather than breaking them.
 */
export function canSpeakToAgent(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!socketPath) return false;
  if (platform !== 'win32') return true;
  return WINDOWS_PIPE.test(socketPath);
}

/**
 * The private symbol ssh2 stamps on a parsed key. `parseKey()` returns any
 * object carrying it untouched, which is how a certificate — unparseable by
 * definition — can still travel through ssh2's key handling.
 *
 * Read off a throwaway generated key rather than hardcoded, so it follows
 * ssh2 rather than a copy of its source. Null means ssh2's internals moved,
 * and every caller then falls back to stock behaviour.
 */
let cachedSymbol: symbol | null | undefined;

/**
 * Public halves of three throwaway keys, one per algorithm family. Public
 * keys are not secrets; these exist only to be parsed.
 *
 * Why three, and why not generate one: `parseKey` rejects any type ssh2
 * considers unsupported, and ed25519 support is decided AT RUNTIME —
 * `eddsaSupported` in `ssh2/lib/protocol/constants.js` actually signs and
 * verifies a sample key on load and can come out false. An earlier version
 * of this function generated an ed25519 key and parsed that, so on any
 * machine where ed25519 was unavailable the symbol lookup failed and EVERY
 * agent user lost authentication, certificates or not. CI reproduced it.
 *
 * `ssh-rsa` is the one type ssh2 supports unconditionally, so it is tried
 * first; the others are there so a future ssh2 that drops RSA does not put
 * us back in the same position.
 */
const SAMPLE_PUBLIC_KEYS = [
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCyNryM6KQyTgwlaqrs36KJ32coN9RBtSIc4eAdigNygNtZSO6rasxhXhDswernr6nXVhc9lB+iJxzHWATGWXRdsmeuwgXvUF1+RrjbRwlxy0Lx2gjq1krI4eZQGRjK/Lr5KV3JKSZP+PCbOrr5nD7iBuMjOIZxQxY2DTSlKPwz0k6kdqESPt4P4ufvZn9CiBKFsxuGcR/wcyFZzRFN8UNusgI12AV+DvNFEJDmaD/7B6kyeHcoMJkYmkVkJpPkH0NVjv1RGDSwAUoTrIEKOycGHdNcxzHTYs/t5JNCBB8giXHCjo84O4oycE/54dQkxF2TY2p6bAiPj+jXgD+kpEdh sample',
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBNWKSjk7yTKjo7iOH2JvyOJRiqclHiP+GzTrLvGIK+V3tPD9KAAP0ODaUCeeY2e/kF/7swf6vOvAC2qDlVZ3ps8= sample',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKsi+DBwARVUK0nEuctcLLFawv/t0rnuO8cOvOiqxgSA sample',
] as const;

export function parsedKeySymbol(): symbol | null {
  if (cachedSymbol !== undefined) return cachedSymbol;
  cachedSymbol = null;
  const refusals: string[] = [];

  for (const sample of SAMPLE_PUBLIC_KEYS) {
    let parsed: ReturnType<typeof utils.parseKey>;
    try {
      parsed = utils.parseKey(sample);
    } catch (e) {
      refusals.push(`${sample.split(' ')[0]}: threw ${errorMessage(e)}`);
      continue;
    }
    if (parsed instanceof Error) {
      // Not an exception, so it used to disappear without a word — which is
      // exactly how this failure hid the first time.
      refusals.push(`${sample.split(' ')[0]}: ${parsed.message}`);
      continue;
    }
    const fields = parsed as unknown as Record<symbol, unknown>;
    const found = Object.getOwnPropertySymbols(parsed)
      .find((sym) => typeof fields[sym] === 'boolean');
    if (found) {
      cachedSymbol = found;
      return cachedSymbol;
    }
    refusals.push(`${sample.split(' ')[0]}: parsed, but carries no marker`);
  }

  logger.warn(
    'CertificateAgent: ssh2 would not parse any sample key, so agent identities ' +
    `stay unavailable — ${refusals.join('; ')}`,
  );
  return cachedSymbol;
}

/** The subset of a parsed key that ssh2's publickey auth actually touches. */
export interface AgentPublicKey {
  type: string;
  comment: string;
  getPublicSSH(): Buffer;
  isPrivateKey(): boolean;
  equals(other: unknown): boolean;
}

// Re-exported so callers that think in terms of the agent keep one import.
export { baseKeyType, isCertificateType };

/**
 * The public key algorithm name to put on the wire for a certificate.
 *
 * For most types this is the certificate type itself, because the algorithm
 * that signs and the algorithm that names the key are the same string. RSA is
 * the exception: an agent lists the identity as
 * `ssh-rsa-cert-v01@openssh.com`, but that name means SHA-1, and servers have
 * been refusing SHA-1 signatures since OpenSSH 8.8. We ask the agent for
 * SHA-512 (see `rsaFlags`), so the name on the wire has to say so too —
 * OpenSSH's `sshkey_check_sigtype()` rejects the login when the two disagree,
 * which is exactly what an RSA certificate did before this existed.
 *
 * `rsa-sha2-512-cert-v01@openssh.com` is a public key algorithm name only; the
 * blob it accompanies is still the `ssh-rsa-cert-v01@openssh.com` certificate
 * (RFC 8332 §3, OpenSSH PROTOCOL.certkeys).
 */
export function certificateAlgorithm(certType: string): string {
  // Only certificates are renamed. A PLAIN `ssh-rsa` key keeps its name:
  // ssh2 negotiates rsa-sha2-* for those itself (`getKeyAlgos`), and calling
  // a plain key by a certificate's name would be a lie the server sees.
  if (!isCertificateType(certType)) return certType;
  return baseKeyType(certType) === 'ssh-rsa'
    ? 'rsa-sha2-512-cert-v01@openssh.com'
    : certType;
}

export function makeAgentKey(
  type: string, comment: string, blob: Buffer, marker: symbol,
): AgentPublicKey {
  return {
    type,
    comment,
    [marker]: true,
    getPublicSSH: () => blob,
    isPrivateKey: () => false,
    equals: (other: unknown) => {
      const o = other as { getPublicSSH?: () => Buffer } | null;
      return !!o && typeof o.getPublicSSH === 'function' && o.getPublicSSH().equals(blob);
    },
  };
}

type SignCallback = (err: Error | null, signature?: Buffer) => void;

export class CertificateAgent extends BaseAgent<ParsedKey> {
  constructor(
    private readonly socketPath: string,
    /** Budget for LISTING identities. Signing has its own — see below. */
    private readonly opts: AgentQueryOptions = {},
    /** Budget for a SIGNATURE, which may be waiting on a person. */
    private readonly signTimeoutMs: number = SIGN_TIMEOUT_MS,
  ) {
    super();
  }

  getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void): void {
    const marker = parsedKeySymbol();
    if (!marker) {
      cb(new Error('Cannot offer agent identities: ssh2 internals changed'));
      return;
    }
    listAgentIdentityBlobs(this.socketPath, this.opts).then((all) => {
      // An identity we cannot sign for still costs a round trip and one of
      // the server's MaxAuthTries (commonly 6), so it must not be offered —
      // which is also what the failure diagnosis tells the user happens.
      const offered = all.filter((i) => isUsableIdentity(i.type));
      const skipped = all.filter((i) => !isUsableIdentity(i.type));
      logger.info(
        `CertificateAgent: offering ${offered.length} of ${all.length} identities — ` +
        `${offered.map((i) => i.type).join(', ') || '(none)'}` +
        (skipped.length ? `; skipped ${skipped.map((i) => i.type).join(', ')}` : ''),
      );
      cb(undefined, offered.map(
        // Named for the wire, not for the agent's listing: ssh2 writes this
        // `type` into BOTH the "would you accept this key" probe and the
        // signed request, and for an RSA certificate those must say SHA-2 or
        // the server refuses the probe outright ("signature algorithm
        // ssh-rsa-cert-v01@openssh.com not in PubkeyAcceptedAlgorithms").
        (i) => makeAgentKey(
          certificateAlgorithm(i.type), i.comment, i.blob, marker,
        ) as unknown as ParsedKey,
      ));
    }).catch((e) => cb(e instanceof Error ? e : new Error(String(e))));
  }

  sign(pubKey: ParsedKey, data: Buffer, options: unknown, cb?: unknown): void {
    const callback = (typeof options === 'function' ? options : cb) as SignCallback | undefined;
    if (!callback) {
      // ssh2 always passes one today. If that ever changes, returning quietly
      // would leave its auth state machine waiting for a signature that never
      // comes — a hang with nothing in the log to explain it.
      logger.warn('CertificateAgent.sign called with no callback; ignoring the request');
      return;
    }
    const hash = typeof options === 'object' && options !== null
      ? (options as { hash?: string }).hash
      : undefined;

    const key = pubKey as unknown as AgentPublicKey;
    const request = Buffer.concat([
      Buffer.from([SSH_AGENTC_SIGN_REQUEST]),
      sshString(key.getPublicSSH()),
      sshString(data),
      rsaFlags(key.type, hash),
    ]);

    // Deliberately NOT `this.opts`: that budget is for listing identities, and
    // a signature can be blocked on a person touching a key. Inheriting it
    // would quietly reimpose the 2 s cap the moment anyone makes the listing
    // timeout configurable — see SIGN_TIMEOUT_MS.
    agentRoundTrip(this.socketPath, request, { timeoutMs: this.signTimeoutMs })
      .then((body) => callback(null, signatureFor(key.type, parseSignResponse(body))))
      .catch((e) => callback(e instanceof Error ? e : new Error(String(e))));
  }
}

/**
 * RSA is the only type where the caller picks a hash. ssh2 asks for one on a
 * plain key and must get what it asked for, since it writes that name on the
 * wire. For a certificate it asks for nothing and modern servers want SHA-2,
 * so choose SHA-512 — `enableCertificateAuth` copies whatever the agent
 * answers with into the packet, so the two cannot disagree.
 */
function rsaFlags(type: string, hash: string | undefined): Buffer {
  const flags = Buffer.alloc(4);
  const base = baseKeyType(type);
  // `rsa-sha2-512` is what an RSA certificate is called once renamed for the
  // wire (see `certificateAlgorithm`); `ssh-rsa` is a plain key or a
  // certificate that has not been renamed.
  if (base !== 'ssh-rsa' && base !== 'rsa-sha2-256' && base !== 'rsa-sha2-512') return flags;
  if (hash === 'sha256' || base === 'rsa-sha2-256') {
    flags.writeUInt32BE(SSH_AGENT_RSA_SHA2_256, 0);
  } else if (hash === 'sha512' || base === 'rsa-sha2-512') {
    flags.writeUInt32BE(SSH_AGENT_RSA_SHA2_512, 0);
  } else if (isCertificateType(type)) {
    flags.writeUInt32BE(SSH_AGENT_RSA_SHA2_512, 0);
  }
  return flags;
}

/**
 * Which half of the agent's answer each consumer needs.
 *
 * ssh2's own agent client strips the algorithm name before handing a
 * signature back, because its `authPK` writes `string(algorithm)
 * string(signature)` itself and expects the raw bytes for the second field
 * (`ssh2/lib/agent.js`: "We strip the algorithm from OpenSSH's output").
 * Returning the whole blob there produces a signature field with a second
 * algorithm name glued inside it, which every server rejects — so plain keys
 * must be stripped exactly as ssh2 does.
 *
 * A certificate is the exception: `certificateAuth` builds that packet
 * itself, and the blob's algorithm is precisely the value ssh2 gets wrong,
 * so it needs the answer intact.
 */
function signatureFor(keyType: string, blob: Buffer): Buffer {
  if (isCertificateType(keyType)) return blob;
  if (blob.length < 4) throw new Error('malformed signature (no algorithm)');
  const algoLen = blob.readUInt32BE(0);
  if (4 + algoLen + 4 > blob.length) throw new Error('malformed signature (truncated algorithm)');
  const sigLen = blob.readUInt32BE(4 + algoLen);
  const start = 4 + algoLen + 4;
  if (start + sigLen > blob.length) throw new Error('malformed signature (truncated)');
  return blob.subarray(start, start + sigLen);
}

/**
 * The body of a SIGN_RESPONSE: one SSH signature blob, itself
 * `string(algorithm) string(signature)`.
 */
function parseSignResponse(body: Buffer): Buffer {
  if (body.length < 1) throw new Error('empty signature reply from the SSH agent');
  if (body[0] === SSH_AGENT_FAILURE) throw new Error('the SSH agent refused to sign');
  if (body[0] !== SSH_AGENT_SIGN_RESPONSE) {
    throw new Error(`unexpected SSH agent reply type ${body[0]} for a signature request`);
  }
  if (body.length < 5) throw new Error('malformed signature reply (no length)');
  const len = body.readUInt32BE(1);
  if (5 + len > body.length) throw new Error('malformed signature reply (truncated)');
  return body.subarray(5, 5 + len);
}
