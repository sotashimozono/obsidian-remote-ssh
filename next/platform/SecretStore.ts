/**
 * Platform-agnostic secret store interface.
 *
 * Implementations:
 *  - Desktop: plugin/src/ssh/SecretStore.ts (Obsidian's built-in secret store)
 *  - Mobile:  mobile/src/platform/MobileSecretStore.ts (Capacitor Preferences)
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
