import * as crypto from 'crypto';
import { logger } from '../util/logger';

export class HostKeyStore {
  private store: Map<string, string> = new Map();

  load(savedFingerprints: Record<string, string>) {
    this.store = new Map(Object.entries(savedFingerprints));
  }

  serialize(): Record<string, string> {
    return Object.fromEntries(this.store);
  }

  verify(host: string, port: number, keyBuffer: Buffer): boolean {
    const key = `${host}:${port}`;
    const fingerprint = crypto.createHash('sha256').update(keyBuffer).digest('hex');

    const known = this.store.get(key);
    if (!known) {
      logger.info(`TOFU: Trusting new host key for ${key}: SHA256:${fingerprint.slice(0, 16)}...`);
      this.store.set(key, fingerprint);
      return true;
    }
    if (known !== fingerprint) {
      logger.error(`Host key mismatch for ${key}! Expected ${known.slice(0, 16)}... got ${fingerprint.slice(0, 16)}...`);
      return false;
    }
    return true;
  }

  forget(host: string, port: number) {
    this.store.delete(`${host}:${port}`);
  }
}
