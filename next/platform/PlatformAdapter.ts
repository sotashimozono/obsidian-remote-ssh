import type { SecretStore } from './SecretStore.js';

/**
 * Platform abstraction — each target (Desktop, Mobile-iOS, Mobile-Android)
 * provides one implementation. The plugin core depends only on this interface,
 * never on ssh2 or WebSocket directly.
 */
export interface PlatformAdapter {
  readonly name: 'desktop' | 'mobile-ios' | 'mobile-android';
  /** True if the platform can open raw TCP sockets (i.e., Node.js is available). */
  readonly supportsNativeSsh: boolean;
  /** True if the platform has browser-standard WebSocket API. */
  readonly supportsWebSocket: boolean;

  createSecretStore(): SecretStore;
  createTransport(config: TransportConfig): Promise<RemoteFsClientLike>;
}

export interface TransportConfig {
  mode: 'ssh-direct' | 'ws-relay';
  // ssh-direct
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  privateKey?: string;
  // ws-relay
  relayUrl?: string;
  sessionToken?: string;
}

/** Minimal surface needed from a transport — matches RemoteFsClient. */
export interface RemoteFsClientLike {
  isAlive(): boolean;
  onClose(cb: (info: { unexpected: boolean }) => void): () => void;
}
