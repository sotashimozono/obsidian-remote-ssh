import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Connection coordinates for the Docker test sshd — same as the
 * integration test helpers to reuse the same container.
 */
const TEST_HOST = '127.0.0.1';
const TEST_PORT = 2222;
const TEST_USER = 'tester';
const TEST_VAULT_REMOTE = `/home/${TEST_USER}/vault`;

const PLUGIN_ID = 'remote-ssh';

export interface ScaffoldResult {
  vaultPath: string;
  cleanup: () => void;
}

/**
 * Create a temporary Obsidian vault with the remote-ssh plugin
 * pre-installed and a test SSH profile pre-configured.
 *
 * The vault is ready to be opened by Obsidian — the plugin will
 * auto-connect on launch if `autoConnectProfileId` is set in
 * `data.json`.
 */
export function scaffoldTestVault(): ScaffoldResult {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-vault-'));

  // .obsidian base
  const obsidianDir = path.join(vaultPath, '.obsidian');
  fs.mkdirSync(obsidianDir, { recursive: true });

  // Install the plugin
  const pluginDir = path.join(obsidianDir, 'plugins', PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });

  // Copy built plugin files
  const filesToCopy = ['main.js', 'manifest.json', 'styles.css'];
  for (const file of filesToCopy) {
    const src = path.join(pluginRoot, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(pluginDir, file));
    }
  }

  // Copy server binary if available
  const serverBinDir = path.join(pluginRoot, 'server-bin');
  if (fs.existsSync(serverBinDir)) {
    const destBinDir = path.join(pluginDir, 'server-bin');
    fs.mkdirSync(destBinDir, { recursive: true });
    for (const entry of fs.readdirSync(serverBinDir)) {
      fs.copyFileSync(
        path.join(serverBinDir, entry),
        path.join(destBinDir, entry),
      );
    }
  }

  // Resolve test private key path
  const privateKeyPath = path.resolve(
    pluginRoot, '..', 'docker', 'keys', 'id_test',
  );

  // Write data.json with a pre-configured test profile
  const dataJson = {
    profiles: [
      {
        id: 'e2e-test-profile',
        name: 'E2E Test',
        host: TEST_HOST,
        port: TEST_PORT,
        username: TEST_USER,
        authMethod: 'privateKey',
        privateKeyPath,
        remotePath: TEST_VAULT_REMOTE,
        transport: 'rpc',
        connectTimeoutMs: 30_000,
        keepaliveIntervalMs: 10_000,
        keepaliveCountMax: 3,
      },
    ],
    settings: {
      clientId: 'e2e-test',
      debugLogging: true,
    },
  };

  fs.writeFileSync(
    path.join(pluginDir, 'data.json'),
    JSON.stringify(dataJson, null, 2),
    'utf8',
  );

  // Enable the plugin in community-plugins.json
  fs.writeFileSync(
    path.join(obsidianDir, 'community-plugins.json'),
    JSON.stringify([PLUGIN_ID]),
    'utf8',
  );

  // Minimal app.json so Obsidian doesn't show the first-run wizard
  fs.writeFileSync(
    path.join(obsidianDir, 'app.json'),
    JSON.stringify({}),
    'utf8',
  );

  const cleanup = () => {
    try {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  return { vaultPath, cleanup };
}
