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

  // Core plugins — enable file-explorer + command-palette, disable
  // everything else. Matches a minimal trusted vault.
  fs.writeFileSync(
    path.join(obsidianDir, 'core-plugins.json'),
    JSON.stringify({
      'file-explorer': true,
      'global-search': true,
      'switcher': false,
      'graph': false,
      'backlink': false,
      'canvas': false,
      'outgoing-link': false,
      'tag-pane': false,
      'properties': false,
      'page-preview': false,
      'daily-notes': false,
      'templates': false,
      'note-composer': false,
      'command-palette': true,
      'editor-status': true,
      'bookmarks': false,
      'file-recovery': false,
      'publish': false,
      'sync': false,
    }, null, 2),
    'utf8',
  );

  // Core plugins migration — tells Obsidian we've already seen the
  // first-run migration so it won't prompt.
  fs.writeFileSync(
    path.join(obsidianDir, 'core-plugins-migration.json'),
    JSON.stringify({
      'file-explorer': true,
      'global-search': true,
      'switcher': true,
      'graph': true,
      'backlink': true,
      'canvas': true,
      'outgoing-link': true,
      'tag-pane': true,
      'properties': true,
      'page-preview': true,
      'daily-notes': true,
      'templates': true,
      'note-composer': true,
      'command-palette': true,
      'editor-status': true,
      'bookmarks': true,
      'file-recovery': true,
      'publish': true,
      'sync': true,
    }, null, 2),
    'utf8',
  );

  // app.json — suppress delete confirmation and other first-run prompts
  fs.writeFileSync(
    path.join(obsidianDir, 'app.json'),
    JSON.stringify({ promptDelete: false }, null, 2),
    'utf8',
  );

  // appearance.json — dark theme for clean demo screenshots
  fs.writeFileSync(
    path.join(obsidianDir, 'appearance.json'),
    JSON.stringify({ baseFontSize: 16 }, null, 2),
    'utf8',
  );

  // Workspace with file-explorer pinned in the left sidebar
  fs.writeFileSync(
    path.join(obsidianDir, 'workspace.json'),
    JSON.stringify({
      main: {
        id: 'main',
        type: 'split',
        children: [{
          id: 'leaf-main',
          type: 'leaf',
          state: { type: 'empty', state: {} },
        }],
        direction: 'vertical',
      },
      left: {
        id: 'left',
        type: 'split',
        children: [{
          id: 'left-tabs',
          type: 'tabs',
          children: [{
            id: 'leaf-explorer',
            type: 'leaf',
            state: { type: 'file-explorer', state: {} },
          }],
        }],
        direction: 'horizontal',
        width: 250,
        collapsed: false,
      },
      right: { id: 'right', type: 'split', children: [], direction: 'horizontal', collapsed: true },
      'left-ribbon': { hiddenItems: {} },
      active: 'leaf-main',
    }, null, 2),
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
  const notes: Array<{ dir?: string; name: string; content: string }> = [
    {
      name: 'welcome_local.md',
      content: [
        '# Welcome (local)',
        '',
        'This note was created **locally** in the scaffold vault.',
        'When connected, the remote vault will also contain',
        '`welcome_remote.md` and `notes_remote.md` — files that',
        'already existed on the server before you connected.',
        '',
        '## Try it',
        '',
        '1. Connect to the remote via **Remote SSH: Connect**',
        '2. The file explorer shows both `*_local` and `*_remote` files',
        '3. Create `demonstration.md` — it appears on the server too',
        '',
      ].join('\n'),
    },
    {
      name: 'setup_local.md',
      content: [
        '# Setup (local)',
        '',
        'This note describes the local Obsidian environment.',
        '',
        '- **Plugin**: Remote SSH',
        '- **Transport**: RPC (recommended) or SFTP',
        '- **Auth**: private key / password / ssh-agent',
        '',
        'Edits here are written to the remote in real time.',
        '',
      ].join('\n'),
    },
  ];

  for (const note of notes) {
    const dir = note.dir
      ? path.join(vaultPath, note.dir)
      : vaultPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, note.name), note.content, 'utf8');
  }
}
