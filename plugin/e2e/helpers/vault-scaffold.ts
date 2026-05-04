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

  // Pre-write the on-disk state Obsidian normally reaches AFTER the
  // user has gone through Settings -> Community plugins -> Turn on:
  //   community-plugins.json -> these plugins should be enabled
  //   core-plugins.json      -> default core plugins are configured
  //   app.json               -> some user setting has been touched
  //
  // Note: workspace.json is intentionally NOT pre-written. Obsidian's
  // renderer treats a workspace with empty `main.children` as "no
  // active leaf" and paints nothing — the DOM still loads (so
  // page.evaluate works and waitForPluginLoaded passes) but the
  // window is visually black, which broke the demo recording. Let
  // Obsidian generate workspace.json itself on first save with a
  // real leaf view; that produces a visible vault.
  fs.writeFileSync(
    path.join(obsidianDir, 'community-plugins.json'),
    JSON.stringify([PLUGIN_ID]),
    'utf8',
  );

  fs.writeFileSync(
    path.join(obsidianDir, 'core-plugins.json'),
    JSON.stringify([
      'file-explorer', 'global-search', 'switcher', 'graph', 'backlink',
      'canvas', 'outgoing-link', 'tag-pane', 'page-preview', 'daily-notes',
      'templates', 'note-composer', 'command-palette', 'editor-status',
      'bookmarks', 'markdown-importer', 'outline', 'word-count',
      'file-recovery',
    ]),
    'utf8',
  );

  // app.json with a single setting touched. An empty-object app.json
  // is treated as "never configured" by some Obsidian builds.
  fs.writeFileSync(
    path.join(obsidianDir, 'app.json'),
    JSON.stringify({ promptDelete: false }, null, 2),
    'utf8',
  );

  // Seed demo notes so the vault isn't empty in screenshots / tests
  seedDemoNotes(vaultPath);

  const cleanup = () => {
    try {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  return { vaultPath, cleanup };
}

/**
 * Seed the vault with sample markdown notes so the file explorer
 * has visible content in E2E tests and demo screenshots.
 */
function seedDemoNotes(vaultPath: string): void {
  // Five `local_demo*.md` notes, deliberately uniform in shape, so
  // the demo GIF reads as: "the local vault has local_demoN; after
  // connect, the shadow vault has remote_demoN" — a clean visual
  // contrast with the docker/test-vault fixtures of the same shape.
  const N = 5;
  for (let i = 1; i <= N; i++) {
    const content = [
      `# Local demo ${i}`,
      '',
      'This note lives **on the local machine** in the scaffold vault.',
      `It is one of ${N} \`local_demo*.md\` files seeded so the file`,
      'explorer has visible content before any SSH connection happens.',
      '',
      'After **Remote SSH: Connect**, a separate shadow vault opens',
      'with the remote files (`remote_demo1.md` … `remote_demo5.md`).',
      '',
    ].join('\n');
    fs.writeFileSync(
      path.join(vaultPath, `local_demo${i}.md`),
      content,
      'utf8',
    );
  }
}
