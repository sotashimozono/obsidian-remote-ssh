import * as crypto from 'crypto';
import * as os from 'os';
import { logger } from '../util/logger';

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

type StoredSecrets = Record<string, EncryptedBlob>;

/**
 * Encrypts secrets with AES-256-GCM using a key derived from a
 * machine-specific fingerprint.  Much better than plaintext data.json,
 * though not as strong as the OS keychain (Electron safeStorage requires
 * main-process IPC that Obsidian doesn't expose to plugins).
 *
 * Secrets are stored in plugin data under the "secrets" key.
 */
export class SecretStore {
  private key: Buffer;
  private blobs: StoredSecrets = {};

  constructor() {
    this.key = this.deriveKey();
  }

  private deriveKey(): Buffer {
    const fingerprint = `${os.hostname()}::${os.userInfo().username}::obsidian-remote-ssh`;
    const salt = Buffer.from('rsh-salt-v1');
    return crypto.scryptSync(fingerprint, salt, 32);
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  load(stored: StoredSecrets | undefined) {
    this.blobs = stored ?? {};
  }

  serialize(): StoredSecrets {
    return { ...this.blobs };
  }

  // ─── Encrypt / decrypt ────────────────────────────────────────────────────

  set(ref: string, plaintext: string): void {
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.blobs[ref] = {
      iv:   iv.toString('hex'),
      tag:  tag.toString('hex'),
      data: encrypted.toString('hex'),
    };
  }

  get(ref: string): string | undefined {
    const blob = this.blobs[ref];
    if (!blob) return undefined;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(blob.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
      return decipher.update(Buffer.from(blob.data, 'hex')).toString('utf8') + decipher.final('utf8');
    } catch {
      logger.warn(`SecretStore: decryption failed for "${ref}" — key may have changed`);
      return undefined;
    }
  }

  delete(ref: string): void {
    delete this.blobs[ref];
  }

  has(ref: string): boolean {
    return ref in this.blobs;
  }
}
