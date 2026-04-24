import * as fs from 'fs';
import type { ConnectConfig } from 'ssh2';
import type { SshProfile } from '../types';
import { logger } from '../util/logger';
import { expandHome } from '../util/pathUtils';

export class AuthResolver {
  private sessionSecrets: Map<string, string> = new Map();

  storeSecret(ref: string, value: string) {
    this.sessionSecrets.set(ref, value);
  }

  getSecret(ref: string): string | undefined {
    return this.sessionSecrets.get(ref);
  }

  clearSecrets(profileId: string) {
    for (const key of this.sessionSecrets.keys()) {
      if (key.startsWith(profileId)) this.sessionSecrets.delete(key);
    }
  }

  buildAuthConfig(profile: SshProfile): Partial<ConnectConfig> {
    switch (profile.authMethod) {
      case 'password': {
        const password = profile.passwordRef
          ? this.sessionSecrets.get(profile.passwordRef)
          : undefined;
        if (!password) throw new Error(`No password in memory for profile "${profile.name}". Please reconnect.`);
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
          ? this.sessionSecrets.get(profile.passphraseRef)
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
        throw new Error(`Unknown auth method: ${(profile as SshProfile).authMethod}`);
    }
  }
}
