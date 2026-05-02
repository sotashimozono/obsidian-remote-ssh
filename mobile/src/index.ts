export { WsChannel } from './transport/WsChannel.js';
export type { WsChannelOptions } from './transport/WsChannel.js';

export { WsRpcClient, DEFAULT_TIMEOUT_MS } from './transport/WsRpcClient.js';

export { establishWsRpcConnection } from './transport/WsRpcConnection.js';
export type {
  WsRpcConnectionOptions,
  WsRpcConnection,
} from './transport/WsRpcConnection.js';

export { RpcError } from './transport/RpcError.js';

export { WsRemoteFsClient } from './adapter/WsRemoteFsClient.js';

export { createMobileSecretStore } from './platform/MobileSecretStore.js';
export type { SecretStore } from './platform/MobileSecretStore.js';
