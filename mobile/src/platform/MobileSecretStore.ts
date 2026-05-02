/**
 * Minimal secret-storage interface and implementations for Mobile.
 *
 * Primary implementation uses Capacitor's @capacitor/preferences API
 * (async key-value store backed by Keychain on iOS / EncryptedSharedPreferences
 * on Android). Falls back to localStorage when Capacitor is not available
 * (e.g., browser dev environment or unit tests).
 */

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CapacitorPreferences {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
}

declare global {
  interface Window {
    _capacitorPreferences?: CapacitorPreferences;
  }
}

/**
 * Returns a SecretStore backed by Capacitor Preferences when available,
 * or localStorage when running outside a Capacitor context.
 */
export function createMobileSecretStore(): SecretStore {
  const prefs = typeof window !== 'undefined' ? window._capacitorPreferences : undefined;
  if (prefs) {
    return new CapacitorSecretStore(prefs);
  }
  return new LocalStorageSecretStore();
}

class CapacitorSecretStore implements SecretStore {
  constructor(private readonly prefs: CapacitorPreferences) {}

  async get(key: string): Promise<string | null> {
    const { value } = await this.prefs.get({ key });
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prefs.set({ key, value });
  }

  async delete(key: string): Promise<void> {
    await this.prefs.remove({ key });
  }
}

class LocalStorageSecretStore implements SecretStore {
  private readonly prefix = 'obsidian-remote-ssh:';

  async get(key: string): Promise<string | null> {
    return localStorage.getItem(this.prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(this.prefix + key, value);
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.prefix + key);
  }
}
