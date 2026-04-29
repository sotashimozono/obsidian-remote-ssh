import * as fs from 'fs';
import type { ConnectConfig } from 'ssh2';
import type { SshProfile } from '../types';
import type { SecretStore } from './SecretStore';
import { logger } from '../util/logger';
import { expandHome } from '../util/pathUtils';

export class AuthResolver {
  // In-session secrets (e.g. password typed in ConnectModal but not yet persisted)
  private sessionSecrets: Map<string, string> = new Map();

  constructor(private store: SecretStore) {}

  /**
   * Store a secret for this session only (not persisted to disk).
   * Call persistSecret() to also write it to the encrypted store.
   */
  storeSecret(ref: string, value: string) {
    this.sessionSecrets.set(ref, value);
  }

  /**
   * Persist a secret to the encrypted SecretStore (survives restarts).
   */
  persistSecret(ref: string, value: string) {
    this.sessionSecrets.set(ref, value);
    this.store.set(ref, value);
  }

  getSecret(ref: string): string | undefined {
    return this.sessionSecrets.get(ref) ?? this.store.get(ref);
  }

  clearSecrets(profileId: string) {
    for (const key of this.sessionSecrets.keys()) {
      if (key.startsWith(profileId)) this.sessionSecrets.delete(key);
    }
    // Note: encrypted store entries are kept across sessions intentionally
  }

  buildAuthConfig(profile: SshProfile): Partial<ConnectConfig> {
    switch (profile.authMethod) {
      case 'password': {
        const password = profile.passwordRef
          ? this.getSecret(profile.passwordRef)
          : undefined;
        if (!password) throw new Error(`No password stored for profile "${profile.name}". Please reconnect.`);
        return { password };
      }

      case 'privateKey': {
        const keyPath = profile.privateKeyPath ? expandHome(profile.privateKeyPath) : undefined;
        if (!keyPath) throw new Error(`No private key path set for profile "${profile.name}".`);
        let privateKey: Buffer;
        try {
          privateKey = fs.readFileSync(keyPath);
        } catch (e) {
          throw new Error(`Cannot read private key at "${keyPath}": ${(e as Error).message}`);
        }
        const passphrase = profile.passphraseRef
          ? this.getSecret(profile.passphraseRef)
          : undefined;
        logger.info(`Auth: using private key ${keyPath}`);
        return passphrase ? { privateKey, passphrase } : { privateKey };
      }

      case 'agent': {
        const agentSocket = profile.agentSocket || process.env.SSH_AUTH_SOCK;
        if (!agentSocket) throw new Error('SSH agent requested but SSH_AUTH_SOCK is not set.');
        logger.info(`Auth: using SSH agent at ${agentSocket}`);
        return { agent: agentSocket };
      }

      default:
        // After exhausting the AuthMethod union the field is typed `never`;
        // re-widen via String() so the error message still surfaces the value
        // if the union ever grows and a case is missed.
        throw new Error(`Unknown auth method: ${String(profile.authMethod)}`);
    }
  }
}
